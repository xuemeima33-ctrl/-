'use strict';
const $=id=>document.getElementById(id);
const state={city:null,searchVersion:0,weatherVersion:0,versions:{current:0,forecast:0},data:{},status:{},controllers:{},busy:{},offset:0,day:null,autoDay:null,cooldown:0};
const text=(tag,value,cls)=>{const el=document.createElement(tag);el.textContent=value;if(cls)el.className=cls;return el;};
const messages={timeout:'请求超时，请重试',rate_limited:'请求较多，请稍后重试',quota_exhausted:'天气服务请求额度暂不可用，请稍后重试',invalid_city:'城市信息已失效，请重新搜索选择',stale_data:'当前天气已过期，请刷新',unavailable:'天气服务暂不可用，请重试',invalid_data:'数据暂不可用，请重试',offline:'网络连接失败，请重试'};
function now(){return Date.now()+state.offset;}
function localDay(tz){return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now()));}
function stamp(value,tz){try{return new Intl.DateTimeFormat('zh-CN',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZoneName:'longOffset'}).format(new Date(value));}catch{return '--';}}
async function api(path,key){
  state.controllers[key]?.abort();
  const controller=new AbortController();state.controllers[key]=controller;
  const timer=setTimeout(()=>controller.abort('timeout'),10000);
  try{
    const response=await fetch(path,{signal:controller.signal});
    const data=await response.json();
    if(!response.ok){const error=new Error(data.error_code||'unavailable');error.retry=data.retry_after;throw error;}
    return data;
  }catch(error){if(controller.signal.aborted){const e=new Error(controller.signal.reason==='timeout'?'timeout':'cancelled');throw e;}throw error;}
  finally{clearTimeout(timer);}
}
function cooldown(data){if(['rate_limited','quota_exhausted'].includes(data.error_code))state.cooldown=Math.max(state.cooldown,Date.now()+Math.min(3600,Math.max(1,Number(data.retry_after)||30))*1000);}
function cooling(){return Date.now()<state.cooldown;}
function render(){
  if(!state.city)return;
  $('weather').hidden=false;$('welcome').hidden=true;
  $('city-label').textContent=[state.city.name,state.city.admin,state.city.country].filter(Boolean).join(' · ');
  const statuses=Object.values(state.status);
  const loading=statuses.includes('loading');
  const success=statuses.filter(x=>x==='success').length;
  const aggregate=loading?'loading':success===2?'ready':success===1?'partial':'error';
  $('weather').dataset.state=aggregate;
  const wait=cooling()?` 请求较多，请在 ${Math.ceil((state.cooldown-Date.now())/1000)} 秒后重试。`:'';
  $('weather-status').textContent=({loading:'正在加载天气…',ready:'查询成功',partial:'部分天气获取失败，可重试失败区块',error:'天气获取失败，请重试'})[aggregate]+wait;
  $('refresh').disabled=loading||cooling();
  for(const part of ['current','forecast']){
    const container=$(part);container.replaceChildren(text('h3',part==='current'?'当前天气':'未来五日 · 当地明日起'));
    const data=state.data[part];const status=state.status[part];
    if(status==='loading')container.append(text('p',data?'正在更新，以下为上次数据':'正在加载…','notice'));
    if(status==='failure')container.append(text('p',messages[state.errors?.[part]]||'获取失败，请重试','notice'));
    if(data){
      const expired=part==='current'&&now()-Date.parse(data.updated_at)>900000;
      const oldDate=part==='forecast'&&localDay(data.timezone)!==new Intl.DateTimeFormat('en-CA',{timeZone:data.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(data.reference_at));
      if(expired)container.append(text('p','历史数据，已过期；请刷新','notice'));
      else if(status==='failure')container.append(text('p','更新失败；以下为历史快照，不属于本次成功结果','notice'));
      if(oldDate)container.append(text('p',`旧日期范围，更新失败：${data.days[0].date} – ${data.days[4].date}`,'notice'));
      container.append(text('p',`当地${part==='current'?'观测':'基准'}时间 ${stamp(part==='current'?data.updated_at:data.reference_at,data.timezone)} · 取数 ${stamp(data.fetched_at,data.timezone)}`,'meta'));
      if(data.completeness==='incomplete')container.append(text('p','部分字段暂无数据，以 -- 显示','meta'));
      if(data.refresh_error)container.append(text('p','补取失败，以下为缓存中仍有效的部分数据，可重试','notice'));
      if(part==='current'){
        const dl=text('dl','','metrics');
        for(const [field,label,unit] of [['temperature','温度','°C'],['feels_like','体感温度','°C'],['condition','天气状况',''],['humidity','湿度','%'],['wind_speed','风速','m/s']]){
          const box=text('div','','metric');box.append(text('dt',label));const dd=text('dd',data.values[field]??'--');dd.append(text('small',data.values[field]==null?'':` ${unit}`));box.append(dd);dl.append(box);
        }container.append(dl);
      }else{
        const days=text('div','','days');
        for(const day of data.days){const box=text('article','','day');box.append(text('strong',day.date),text('p',day.condition??'--','condition'),text('p',`${day.min??'--'} / ${day.max??'--'} °C`));if(day.day_status==='failure')box.append(text('p','该日预报获取失败','meta'));days.append(box);}container.append(days);
      }
    }
    if(status==='failure'||data?.completeness==='incomplete'||data?.refresh_error){const button=text('button','重试区块');button.type='button';button.disabled=status==='loading'||cooling();button.onclick=()=>weather(part,true);container.append(button);}
  }
}
async function weather(part='all',refresh=false){
  if(!state.city)return;
  if(cooling()){for(const p of ['current','forecast']){state.status[p]='failure';state.errors??={};state.errors[p]='rate_limited';}render();return;}
  const metadata=state.data.forecast||state.data.current;
  if(part!=='all'&&metadata&&localDay(metadata.timezone)!==state.day)part='all';
  const parts=part==='all'?['current','forecast']:[part];
  const cityKey=state.city.city_key;const generation=state.weatherVersion;
  const versions={};for(const p of parts){versions[p]=++state.versions[p];state.status[p]='loading';}
  render();
  try{
    const result=await api(`/api/weather?city_key=${encodeURIComponent(cityKey)}&module=${part}&refresh=${refresh?'1':'0'}`,part);
    if(generation!==state.weatherVersion||cityKey!==state.city?.city_key)return;
    state.offset=result.server_now*1000-Date.now();
    for(const p of parts){
      if(versions[p]!==state.versions[p])continue;
      const data=result[p];state.status[p]=data.status;cooldown(data);
      if(data.status==='success')state.data[p]=data;
      else{state.errors??={};state.errors[p]=data.error_code;}
    }
    const meta=state.data.forecast||state.data.current;
    if(meta)state.day=localDay(meta.timezone);
  }catch(error){
    if(generation!==state.weatherVersion||cityKey!==state.city?.city_key||error.message==='cancelled')return;
    cooldown({error_code:error.message,retry_after:error.retry});
    for(const p of parts)if(versions[p]===state.versions[p]){state.status[p]='failure';state.errors??={};state.errors[p]=error.message;}
  }
  render();
}
function select(city){
  const same=state.city?.city_key===city.city_key;
  for(const key of ['all','current','forecast'])state.controllers[key]?.abort();
  state.weatherVersion++;state.city=city;
  if(!same){state.data={};state.status={};state.errors={};state.day=null;state.autoDay=null;$('pause-notice').textContent='';}
  $('candidates').replaceChildren();weather('all',same);
}
$('search-form').addEventListener('submit',async event=>{
  event.preventDefault();const q=$('query').value.trim();
  if(!q||[...q].length>100){$('search-status').textContent=q?'最多 100 个字符':'请输入城市名称';return;}
  if(cooling()){$('search-status').textContent='请求较多，请等待冷却结束后重试';return;}
  if(state.searchPending===q)return;
  const version=++state.searchVersion;state.searchPending=q;
  $('candidates').replaceChildren();$('search-status').textContent='正在搜索城市…';
  try{
    const result=await api(`/api/search?q=${encodeURIComponent(q)}`,'search');if(version!==state.searchVersion)return;
    if(!Array.isArray(result.candidates))throw new Error('invalid_data');
    let selectable=0;
    for(const city of result.candidates){
      const li=document.createElement('li');const button=text('button',[city.name,city.admin,city.country,city.lat==null?'':`(${city.lat}, ${city.lon})`].filter(Boolean).join(' · ')||'城市信息缺失');
      button.type='button';button.disabled=!(city.city_key&&city.name&&city.country);if(!button.disabled)selectable++;
      button.onclick=()=>select(city);li.append(button);$('candidates').append(li);
    }
    $('search-status').textContent=!result.candidates.length?'未找到匹配城市，请修改名称':!selectable?'暂无可选择城市，请补充城市名称':`找到 ${result.candidates.length} 个候选，请选择城市${result.truncated?'；候选较多，请补充城市名称':''}`;
    $('candidates').querySelector('button:not(:disabled)')?.focus();
  }catch(error){if(version===state.searchVersion&&error.message!=='cancelled'){cooldown({error_code:error.message,retry_after:error.retry});$('search-status').textContent=messages[error.message]||'城市搜索失败，请重试';}}
  finally{if(version===state.searchVersion)state.searchPending=null;}
});
$('query').addEventListener('input',()=>{state.searchVersion++;state.searchPending=null;state.controllers.search?.abort();$('candidates').replaceChildren();$('search-status').textContent='输入城市名称，从候选列表中确认地点。';});
$('refresh').onclick=()=>weather('all',true);
let wasCooling=false;
function tick(resumed=false){
  if(!state.city)return;
  let changed=cooling()||wasCooling;wasCooling=cooling();
  const metadata=state.data.forecast||state.data.current;
  if(metadata){
    const day=localDay(metadata.timezone);
    if(state.day&&day!==state.day&&state.autoDay!==day){state.autoDay=day;if(resumed)$('pause-notice').textContent='页面暂停期间未及时更新，正在重新查询。';weather('all',true);}
    const c=state.data.current;
    if(c&&state.status.current==='success'&&now()-Date.parse(c.updated_at)>900000){state.status.current='failure';state.errors??={};state.errors.current='stale_data';changed=true;}
  }
  if(changed)render();
}
// Calendar-date checks use server-adjusted time and city IANA timezone, not 24-hour arithmetic.
setInterval(()=>tick(),1000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)tick(true);});
window.addEventListener('pageshow',()=>tick(true));
