"""WeatherAPI adapter and deterministic PRD data contracts. No client secrets."""
import ipaddress
import math
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from zoneinfo import ZoneInfo

# WeatherAPI condition code contract; unknown codes are missing data.
CONDITIONS = {
    1000:'晴',1003:'局部多云',1006:'多云',1009:'阴',1030:'薄雾',
    1063:'局部有雨',1066:'局部有雪',1069:'局部雨夹雪',1072:'局部冻毛毛雨',
    1087:'局部雷雨',1114:'吹雪',1117:'暴风雪',1135:'雾',1147:'冻雾',
    1150:'零星毛毛雨',1153:'毛毛雨',1168:'冻毛毛雨',1171:'强冻毛毛雨',
    1180:'零星小雨',1183:'小雨',1186:'间歇中雨',1189:'中雨',1192:'间歇大雨',
    1195:'大雨',1198:'小冻雨',1201:'中到大冻雨',1204:'小雨夹雪',1207:'中到大雨夹雪',
    1210:'零星小雪',1213:'小雪',1216:'间歇中雪',1219:'中雪',1222:'间歇大雪',
    1225:'大雪',1237:'冰粒',1240:'小阵雨',1243:'中到大阵雨',1246:'强阵雨',
    1249:'小阵性雨夹雪',1252:'中到大阵性雨夹雪',1255:'小阵雪',1258:'中到大阵雪',
    1261:'小阵性冰粒',1264:'中到大阵性冰粒',1273:'小雷雨',1276:'中到大雷雨',
    1279:'小雷雪',1282:'中到大雷雪'
}
# ECMAScript trim whitespace, shared with browser String.trim().
WHITESPACE='\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'

def query_text(value):
    if not isinstance(value,str): raise ValueError('query')
    value=value.strip(WHITESPACE)
    if not 1<=len(value)<=100 or any(0xD800<=ord(c)<=0xDFFF for c in value): raise ValueError('query')
    return value

def number(value, places=0, low=None, high=None):
    if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value): return None
    if low is not None and value<low or high is not None and value>high: return None
    result=float(Decimal(str(value)).quantize(Decimal(10)**-places,rounding=ROUND_HALF_UP))
    return (int(result) if not places else result) or 0

def public_addresses(addresses):
    if not addresses: raise ValueError('dns')
    for address in addresses:
        ip=ipaddress.ip_address(address)
        if not ip.is_global or ip.is_multicast or (ip.version==6 and ip.ipv4_mapped): raise ValueError('ssrf')
    return addresses

def dates(reference, tz):
    day=datetime.fromtimestamp(reference,ZoneInfo(tz)).date()
    return [(day+timedelta(days=i)).isoformat() for i in range(1,6)]

def iso(epoch):
    return datetime.fromtimestamp(epoch,timezone.utc).isoformat()

def condition(obj):
    return CONDITIONS.get(obj.get('condition',{}).get('code')) if isinstance(obj,dict) and isinstance(obj.get('condition',{}),dict) else None

def failure(code='invalid_data'):
    return {'status':'failure','completeness':'none','error_code':code}

def normalize(raw, reference, fetched, module):
    try:
        tz=raw['location']['tz_id']
        targets=dates(reference,tz)
        result={'reference_at':iso(reference),'fetched_at':iso(fetched),'timezone':tz}
        if module=='current':
            c=raw['current']
            observed=c['last_updated_epoch']
            if isinstance(observed,bool) or not isinstance(observed,(int,float)) or not 0<=reference-observed<=900:
                return failure('stale_data')
            wind=c.get('wind_kph')
            wind=wind/3.6 if isinstance(wind,(int,float)) and not isinstance(wind,bool) else None
            values={'temperature':number(c.get('temp_c')),'feels_like':number(c.get('feelslike_c')),
                    'condition':condition(c),'humidity':number(c.get('humidity'),low=0,high=100),
                    'wind_speed':number(wind,1,low=0)}
            if all(v is None for v in values.values()): return failure()
            result.update(values=values,updated_at=iso(observed))
            complete=all(v is not None for v in values.values())
        else:
            rows=raw['forecast']['forecastday']
            if not isinstance(rows,list): return failure()
            grouped={}
            parsed=0
            for row in rows:
                if not isinstance(row,dict): continue
                date=row.get('date')
                try:
                    if datetime.strptime(date,'%Y-%m-%d').date().isoformat()!=date: continue
                except (ValueError,TypeError): continue
                parsed+=1
                d=row.get('day',{})
                if not isinstance(d,dict): d={}
                vals={'max':number(d.get('maxtemp_c'),8),'min':number(d.get('mintemp_c'),8),'condition':condition(d)}
                grouped.setdefault(date,[]).append(vals)
            if rows and not parsed: return failure()
            days=[]
            for date in targets:
                merged={}
                for key in ['max','min','condition']:
                    unique={row[key] for row in grouped.get(date,[]) if row[key] is not None}
                    merged[key]=unique.pop() if len(unique)==1 else None
                if merged['max'] is not None and merged['min'] is not None and merged['max']<merged['min']:
                    merged['max']=merged['min']=None
                for key in ['min','max']:
                    merged[key]=number(merged[key])
                count=sum(v is not None for v in merged.values())
                days.append(dict(merged,date=date,day_status='success' if count==3 else 'partial' if count else 'failure'))
            if all(d['day_status']=='failure' for d in days): return failure()
            result['days']=days
            complete=all(d['day_status']=='success' for d in days)
        result.update(status='success',completeness='complete' if complete else 'incomplete')
        return result
    except (KeyError,TypeError,ValueError,OverflowError):
        return failure()
