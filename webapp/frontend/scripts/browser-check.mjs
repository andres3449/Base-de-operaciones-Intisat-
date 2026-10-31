// Browser smoke/layout checks against a fixture server. Never contacts hardware.
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

const root=resolve('dist'), artifacts=resolve('../../docs/frontend-verification')
await mkdir(artifacts,{recursive:true})
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'}
let authenticated=false
let telemetryValues=[]
const server=createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname
  if(pathname.startsWith('/api/')){
    const fixtures={
      '/api/auth/me':{authenticated},'/api/auth/login':{ok:true},'/api/auth/logout':{ok:true},
      '/api/telemetry/latest':{values:telemetryValues},'/api/telemetry/history':{points:[]},'/api/channels':{channels:['sim.eps_batt_voltage']},
      '/api/status':{zmq_connected:false,last_frame_ts:null,seconds_since_last_frame:null,frames_received:0,backend_uptime_s:1},
      '/api/images':{images:[]},'/api/messages':{messages:[]},'/api/schedule':{once:[],recurring:[]},'/api/commands':{commands:[{name:'STATUS',syntax:'STATUS',description:'Request status'}]},
      '/api/satellite':{satellite:{id:'TEST',name:'Test fixture'},reception:{driver:'rtlsdr',method:'uart8a',modulation:'2FSK',frequency_mhz:437.5,gain_db:40,sync_word:'D391D391'}},
    }
    res.writeHead(pathname in fixtures?200:404,{'Content-Type':'application/json'});res.end(JSON.stringify(fixtures[pathname]??{detail:'Not connected'}));return
  }
  try { const path=resolve(root,'.'+decodeURIComponent(pathname==='/'?'/index.html':pathname));if(!path.startsWith(root))throw Error('Path');const data=await readFile(path);res.writeHead(200,{'Content-Type':mime[extname(path)]??'text/plain'});res.end(data) } catch {res.writeHead(404);res.end('Not found')}
})
server.on('upgrade',(_req,socket)=>socket.destroy())
await new Promise(r=>server.listen(0,'127.0.0.1',r))
const base=`http://127.0.0.1:${server.address().port}`
const browserPath=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync)
assert(browserPath,'Chromium browser not installed')
const profile=resolve(artifacts,`browser-profile-${Date.now()}`)
const browser=spawn(browserPath,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'})
const delay=ms=>new Promise(r=>setTimeout(r,ms))
let socket
try{
  let port
  for(let i=0;i<100;i++){try{port=Number((await readFile(resolve(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break}catch{await delay(100)}}
  assert(port,'Browser did not expose CDP')
  const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl)
  await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j})
  let id=0;const pending=new Map(),errors=[]
  socket.onmessage=e=>{const msg=JSON.parse(e.data);if(msg.id){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p?.reject(msg.error):p?.resolve(msg.result)}else if(msg.method==='Runtime.exceptionThrown')errors.push(msg.params.exceptionDetails.exception?.description??msg.params.exceptionDetails.text)}
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});socket.send(JSON.stringify({id:n,method,params}))})
  const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value}
  await cdp('Page.enable');await cdp('Runtime.enable')
  const routes=['dashboard/general','dashboard/eps','dashboard/adcs','dashboard/comms','dashboard/payload','orbita/general','orbita/passes','orbita/calendar','orbita/free','logs/mensajes','logs/variables','configuracion/sdr','configuracion/programacion','configuracion/diagnostico']
  const results=[]
  await cdp('Page.navigate',{url:base+'/#/configuracion/sdr'});await delay(1800)
  assert.match(await evaluate('location.hash'),/login/,'Settings must require login')
  authenticated=true
  await cdp('Page.reload');await delay(1100)
  for(const [width,height] of [[1366,768],[1536,864],[1920,1080]]){
    await cdp('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})
    for(const route of routes){
      await cdp('Page.navigate',{url:base+'/#/'+route});await delay(route.startsWith('orbita')?1300:1050)
      const state=await evaluate(`({route:location.hash,bodyWidth:document.documentElement.scrollWidth,bodyHeight:document.documentElement.scrollHeight,width:innerWidth,height:innerHeight,panels:document.querySelectorAll('.mission-panel').length,iframe:!!document.querySelector('iframe'),text:document.body.innerText.slice(0,250)})`)
      assert.equal(state.bodyWidth,width,`Page horizontal overflow: ${route}`)
      assert.equal(state.bodyHeight,height,`Page vertical overflow: ${route}`)
      assert.equal(state.route,'#/'+route,`Route mismatch: ${route}`)
      results.push({width,height,...state})
      if(width===1366){const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,route.replaceAll('/','-')+'.png'),Buffer.from(shot.data,'base64'))}
      if(route==='dashboard/general')assert(!(await evaluate(`document.querySelector('.mission-donut').innerText`)).includes('0.00'), 'Missing power must not display zero')
      if(route==='orbita/free')assert(await evaluate(`!!document.querySelector('iframe').contentDocument.querySelector('#addPanel')`),'Free View must include panel editor')
    }
  }
  await cdp('Page.navigate',{url:base+'/#/dashboard/eps'});await delay(1100)
  await evaluate(`document.querySelector('.sidebar-collapse-btn').click()`);await delay(200)
  assert(await evaluate(`document.querySelector('.sidebar').classList.contains('collapsed')`))
  await cdp('Page.reload');await delay(1100)
  assert(await evaluate(`document.querySelector('.sidebar').classList.contains('collapsed')`),'Collapse state must persist')
  await cdp('Page.navigate',{url:base+'/#/orbita/free'});await delay(1400)
  const panelCount=await evaluate(`document.querySelector('iframe').contentDocument.querySelectorAll('.opanel').length`)
  await evaluate(`(()=>{const d=document.querySelector('iframe').contentDocument;d.querySelector('#addPanel').click();const f=d.querySelector('#panelForm');for(const [k,v] of Object.entries({name:'Verification formula',formula:'window.alert(1)',x:0,y:0,w:25,h:25,duration:1,step:60}))f.elements[k].value=v;f.requestSubmit()})()`)
  assert(await evaluate(`!!document.querySelector('iframe').contentDocument.querySelector('#panelError').textContent`),'Formula parser must reject executable expressions')
  await evaluate(`(()=>{const d=document.querySelector('iframe').contentDocument;const f=d.querySelector('#panelForm');f.elements.formula.value='altitude + 1';f.requestSubmit()})()`)
  assert.equal(await evaluate(`document.querySelector('iframe').contentDocument.querySelectorAll('.opanel').length`),panelCount+1,'Valid formula must create a panel')
  const before=await evaluate(`(()=>{const d=document.querySelector('iframe').contentDocument,p=d.querySelector('.opanel:last-child');return {left:p.style.left,width:p.style.width}})()`)
  await evaluate(`(()=>{const d=document.querySelector('iframe').contentDocument,h=d.querySelector('.opanel:last-child .opanelhead'),w=d.defaultView;h.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));h.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true}));d.querySelector('#savePanels').click()})()`)
  const after=await evaluate(`(()=>{const p=document.querySelector('iframe').contentDocument.querySelector('.opanel:last-child');return {left:p.style.left,width:p.style.width}})()`)
  assert.notEqual(after.left,before.left,'Panel must move');assert.notEqual(after.width,before.width,'Panel must resize')
  await cdp('Page.reload');await delay(1400)
  assert.equal(await evaluate(`document.querySelector('iframe').contentDocument.querySelectorAll('.opanel').length`),panelCount+1,'Panel layout must persist')
  await evaluate(`(()=>{const d=document.querySelector('iframe').contentDocument,e=d.querySelector('#workspaceTime');e.value='2026-10-28T12:34:56';e.dispatchEvent(new d.defaultView.Event('change',{bubbles:true}))})()`)
  await cdp('Page.navigate',{url:base+'/#/orbita/passes'});await delay(1400)
  assert.equal(await evaluate(`document.querySelector('iframe').contentWindow.eval('time')`),Date.parse('2026-10-28T12:34:56Z'),'Scene clock must be shared across orbit routes')
  telemetryValues=[{channel:'sim.eps_batt_voltage',value:0,ts:Date.now()/1000},{channel:'sim.eps_batt_current',value:123,ts:Date.now()/1000-120}]
  await cdp('Page.navigate',{url:base+'/#/dashboard/general'});await cdp('Page.reload');await delay(1200)
  const values=await evaluate(`Array.from(document.querySelectorAll('.mission-metric')).map(e=>e.innerText)`)
  assert(values.some(v=>v.includes('Battery')&&v.includes('0.00 V')),'A real zero must remain visible')
  assert(!values.some(v=>v.includes('123.00')),'Stale telemetry must not be displayed as current')
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false})
  const shot=await cdp('Page.captureScreenshot',{format:'png'});await writeFile(resolve(artifacts,'mobile.png'),Buffer.from(shot.data,'base64'))
  await writeFile(resolve(artifacts,'browser-results.json'),JSON.stringify({results,errors},null,2))
  assert.equal(errors.length,0,errors.join('\n'))
  console.log(`PASS: ${results.length} route/viewport combinations, authentication guard, sidebar persistence, missing power, real zero, stale telemetry, formula validation, panel creation/move/resize/persistence, shared orbit clock. No uncaught browser errors.`)
}finally{socket?.close();browser.kill();server.close()}
