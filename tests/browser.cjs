// Deterministic browser checks: intercepted fixture APIs, never real weather.
const assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let ref=Date.parse('2026-10-16T12:00:00Z'),mode='ready',weatherCalls=0,searchCalls=0,delayA=false;
 const cities=[{city_key:'a'.repeat(32),name:'London <script>alert(1)</script>',admin:'England',country:'UK',lat:51.5,lon:-0.1},{city_key:'b'.repeat(32),name:'Paris',admin:'Île-de-France',country:'France',lat:48.85,lon:2.35}];
 await page.clock.install({time:new Date(ref)});
 function moduleData(part){
  if(mode==='error'||(mode==='partial'&&part==='forecast'))return {status:'failure',completeness:'none',error_code:'unavailable'};
  const data={status:'success',completeness:'complete',timezone:'UTC',reference_at:new Date(ref).toISOString(),fetched_at:new Date(ref).toISOString()};
  if(part==='current')Object.assign(data,{updated_at:new Date(ref-60000).toISOString(),values:{temperature:0,feels_like:-2,condition:'晴',humidity:0,wind_speed:1.3}});
  else data.days=Array.from({length:5},(_,i)=>({date:new Date(ref+(i+1)*86400000).toISOString().slice(0,10),max:10,min:0,condition:'晴',day_status:'success'}));
  return data;
 }
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/api/search'){searchCalls++;return route.fulfill({json:{candidates:url.searchParams.get('q')==='empty'?[]:cities}});}
  weatherCalls++;
  const city=cities.find(c=>c.city_key===url.searchParams.get('city_key'));
  const data={city,reference_at:ref/1000,server_now:ref/1000,current:moduleData('current'),forecast:moduleData('forecast')};
  if(delayA&&city===cities[0])await new Promise(r=>setTimeout(r,300));
  await route.fulfill({json:data}).catch(()=>{});
 });
 const waitState=async value=>page.waitForFunction(v=>document.querySelector('#weather').dataset.state===v,value);
 async function search(value){await page.locator('#query').fill(value);await page.locator('#search-submit').click();await page.waitForFunction(()=>!document.querySelector('#search-status').textContent.includes('正在搜索'));}
 await page.goto(process.env.WEATHER_URL||'http://127.0.0.1:8000');
 await search('London');assert.equal(weatherCalls,0,'single search must not select automatically');
 await page.locator('#candidates button').first().click();await waitState('ready');
 assert.match(await page.locator('#city-label').innerText(),/<script>/,'city labels rendered as text');
 assert.equal(await page.locator('#city-label script').count(),0);
 assert.equal(await page.locator('.metric').count(),5);assert.equal(await page.locator('.day').count(),5);
 for(const width of [320,375,768,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`overflow at ${width}`);}
 console.log('PASS search, explicit selection, escaped labels, five metrics/days, 4 widths');
 mode='partial';await page.locator('#refresh').click();await waitState('partial');assert.match(await page.locator('#forecast').innerText(),/历史快照/);
 mode='error';await page.locator('#refresh').click();await waitState('error');assert.match(await page.locator('#current').innerText(),/历史快照/);
 mode='ready';await page.locator('#refresh').click();await waitState('ready');
 await page.clock.fastForward(900001);await waitState('partial');assert.match(await page.locator('#current').innerText(),/历史数据，已过期/);
 console.log('PASS ready/partial/error, failed refresh snapshots, current expiry');
 // Set server reference immediately before midnight; subsequent response has new day.
 ref=Date.parse('2026-10-16T23:59:59Z');await page.locator('#refresh').click();await waitState('ready');
 const before=weatherCalls;ref+=2000;await page.clock.fastForward(2000);await page.waitForFunction(()=>document.querySelector('.day strong').textContent==='2026-10-18');assert.equal(weatherCalls,before+1);
 console.log('PASS local midnight refresh shifts five-day range');
 delayA=true;await search('cities');await page.locator('#candidates button').first().click();
 await search('Paris');await page.locator('#candidates button').nth(1).click();await waitState('ready');
 await new Promise(r=>setTimeout(r,400));assert.match(await page.locator('#city-label').innerText(),/^Paris/);
 await search('empty');assert.match(await page.locator('#search-status').innerText(),/未找到匹配城市/);
 const oldCount=searchCalls;await page.locator('#query').fill('😀'.repeat(101));await page.locator('#search-submit').click();assert.equal(searchCalls,oldCount);
 await page.locator('#query').fill('London');await page.locator('#query').press('Enter');await page.waitForFunction(()=>document.activeElement?.matches('#candidates button'));await page.keyboard.press('Enter');await waitState('ready');
 await page.evaluate(()=>document.body.style.zoom='2');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow at 200% zoom');await page.evaluate(()=>document.body.style.zoom='1');
 assert.deepEqual(errors,[]);console.log('PASS switching race, empty search, Unicode limit, keyboard selection, 200% zoom; no browser errors');
 await page.screenshot({path:'/tmp/weather-site-desktop.png',fullPage:true});
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
