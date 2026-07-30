import { applyOps } from './worker.js';
import fs from 'fs';
const base = JSON.parse(fs.readFileSync(new URL('../docs/inventory.json', import.meta.url), 'utf8'));
let ok=0, fail=0;
const t=(name,fn)=>{try{fn();console.log('✅',name);ok++}catch(e){console.log('❌',name,'->',e.message);fail++}};
const eq=(a,b,m)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)};
const qty=(inv,id,box)=>((inv.items.find(i=>i.id===id).places||[]).find(p=>(p.box??null)===(box??null))||{}).qty||0;
const total=(inv,id)=>(inv.items.find(i=>i.id===id).places||[]).reduce((s,p)=>s+p.qty,0);

t('建箱子',()=>{
  const r=applyOps(base,[{op:'addBox',box:{rack:'L1',level:2,slot:'c',label:'礼盒'}}]);
  eq(r.layout.boxes.length,1,'箱数'); eq(r.layout.boxes[0].id,'L1-2-c','箱号');
  eq(base.layout.boxes.length,0,'不能改到原对象');
});
t('重复建箱报错',()=>{
  try{applyOps(base,[{op:'addBox',box:{rack:'L1',level:2,slot:'c'}},{op:'addBox',box:{rack:'L1',level:2,slot:'c'}}]);throw new Error('应该报错')}
  catch(e){if(!e.message.includes('已经有箱子'))throw e}
});
t('非法层/槽被拒',()=>{
  for(const b of [{rack:'L1',level:9,slot:'a'},{rack:'L1',level:1,slot:'z'},{rack:'XX',level:1,slot:'a'}]){
    let threw=false; try{applyOps(base,[{op:'addBox',box:b}])}catch(e){threw=true}
    if(!threw)throw new Error('没拦住 '+JSON.stringify(b));
  }
});
t('归位：未归位 -> 箱子',()=>{
  const r=applyOps(base,[{op:'addBox',box:{rack:'L1',level:2,slot:'c'}},{op:'move',id:'001',from:null,to:'L1-2-c',qty:20}]);
  eq(qty(r,'001',null),7,'剩余未归位'); eq(qty(r,'001','L1-2-c'),20,'箱内'); eq(total(r,'001'),27,'总数不变');
});
t('一品多箱，总数=求和',()=>{
  const r=applyOps(base,[
    {op:'addBox',box:{rack:'L1',level:2,slot:'c'}},{op:'addBox',box:{rack:'R2',level:1,slot:'a'}},
    {op:'move',id:'001',from:null,to:'L1-2-c',qty:20},{op:'move',id:'001',from:null,to:'R2-1-a',qty:7}]);
  eq(qty(r,'001',null),0,'未归位清零'); eq(total(r,'001'),27,'总数');
  eq((r.items.find(i=>i.id==='001').places||[]).length,2,'两个 place');
});
t('搬超量被拒',()=>{
  let threw=false;
  try{applyOps(base,[{op:'addBox',box:{rack:'L1',level:1,slot:'a'}},{op:'move',id:'001',from:null,to:'L1-1-a',qty:999}])}catch(e){threw=e.message.includes('只有 27')}
  if(!threw)throw new Error('没拦住超量搬运');
});
t('删箱：有货时拒绝，force 时退回未归位',()=>{
  const mid=applyOps(base,[{op:'addBox',box:{rack:'L1',level:1,slot:'a'}},{op:'move',id:'001',from:null,to:'L1-1-a',qty:27}]);
  let threw=false; try{applyOps(mid,[{op:'delBox',id:'L1-1-a'}])}catch(e){threw=e.message.includes('还有 1 种物料')}
  if(!threw)throw new Error('有货竟然让删');
  const r=applyOps(mid,[{op:'delBox',id:'L1-1-a',force:true}]);
  eq(r.layout.boxes.length,0,'箱已删'); eq(qty(r,'001',null),27,'退回未归位');
});
t('删箱不重排其它槽位（保住实体标签）',()=>{
  const mid=applyOps(base,[{op:'addBox',box:{rack:'L1',level:1,slot:'a'}},{op:'addBox',box:{rack:'L1',level:1,slot:'b'}},{op:'addBox',box:{rack:'L1',level:1,slot:'c'}}]);
  const r=applyOps(mid,[{op:'delBox',id:'L1-1-b'}]);
  eq(r.layout.boxes.map(b=>b.id),['L1-1-a','L1-1-c'],'c 不能变成 b');
});
t('setItem 省略 places 时不动服务端归位',()=>{
  const mid=applyOps(base,[{op:'addBox',box:{rack:'L1',level:1,slot:'a'}},{op:'move',id:'001',from:null,to:'L1-1-a',qty:27}]);
  const it={...mid.items.find(i=>i.id==='001')}; delete it.places; it.name='改了名字';
  const r=applyOps(mid,[{op:'setItem',item:it}]);
  eq(r.items.find(i=>i.id==='001').name,'改了名字','名字改了');
  eq(qty(r,'001','L1-1-a'),27,'归位没被覆盖');
});
t('并发模拟：A 改物料名 + B 归位另一物料，互不覆盖',()=>{
  // 服务端顺序执行两个请求（第二个基于第一个的结果重新 apply）
  const s1=applyOps(base,[{op:'addBox',box:{rack:'R1',level:3,slot:'b'}}]);
  const itA={...s1.items.find(i=>i.id==='005')}; delete itA.places; itA.name='A改的名';
  const s2=applyOps(s1,[{op:'setItem',item:itA}]);
  const s3=applyOps(s2,[{op:'move',id:'009',from:null,to:'R1-3-b',qty:3}]);
  eq(s3.items.find(i=>i.id==='005').name,'A改的名','A 的改动还在');
  eq(qty(s3,'009','R1-3-b'),3,'B 的改动也在');
});
t('新增物料 + 非法 id 被拒',()=>{
  const r=applyOps(base,[{op:'setItem',item:{id:'089',seq:89,name:'新东西',places:[{box:null,qty:5}]}}]);
  eq(total(r,'089'),5,'新物料数量');
  let threw=false; try{applyOps(base,[{op:'setItem',item:{id:'../evil',name:'x'}}])}catch(e){threw=true}
  if(!threw)throw new Error('非法 id 没拦住');
});
t('非法图片路径被过滤',()=>{
  const r=applyOps(base,[{op:'setItem',item:{id:'090',name:'x',photos:['images/ok-1.jpg','../../etc/passwd','images/e.png']}}]);
  eq(r.items.find(i=>i.id==='090').photos,['images/ok-1.jpg'],'只留合法 jpg');
});
t('setPlace 置 0 会移除该 place',()=>{
  const mid=applyOps(base,[{op:'addBox',box:{rack:'L2',level:4,slot:'f'}},{op:'setPlace',id:'002',box:'L2-4-f',qty:10}]);
  eq(qty(mid,'002','L2-4-f'),10,'设了 10');
  const r=applyOps(mid,[{op:'setPlace',id:'002',box:'L2-4-f',qty:0}]);
  eq((r.items.find(i=>i.id==='002').places||[]).some(p=>p.box==='L2-4-f'),false,'place 已移除');
});
t('往不存在的箱子放货被拒',()=>{
  let threw=false; try{applyOps(base,[{op:'move',id:'001',from:null,to:'L9-9-z',qty:1}])}catch(e){threw=e.message.includes('箱子不存在')}
  if(!threw)throw new Error('没拦住');
});
t('全库总数守恒（88 条 2614 件）',()=>{
  const sum=(inv)=>inv.items.reduce((s,i)=>s+(i.places||[]).reduce((t,p)=>t+p.qty,0),0);
  eq(sum(base),2614,'迁移后总数');
  const r=applyOps(base,[{op:'addBox',box:{rack:'L1',level:1,slot:'a'}},{op:'addBox',box:{rack:'L1',level:1,slot:'b'}},
    {op:'move',id:'001',from:null,to:'L1-1-a',qty:27},{op:'move',id:'001',from:'L1-1-a',to:'L1-1-b',qty:12}]);
  eq(sum(r),2614,'搬来搬去总数不变');
});
console.log(`\n${ok} 通过 / ${fail} 失败`);
process.exit(fail?1:0);
