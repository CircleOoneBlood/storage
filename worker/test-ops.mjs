import { applyOps } from './worker.js';
import fs from 'fs';
const base = JSON.parse(fs.readFileSync(new URL('../docs/inventory.json', import.meta.url), 'utf8'));
let ok=0, fail=0;
const t=(name,fn)=>{try{fn();console.log('✅',name);ok++}catch(e){console.log('❌',name,'->',e.message);fail++}};
const eq=(a,b,m)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`)};
const qty=(inv,id,box)=>((inv.items.find(i=>i.id===id).places||[]).find(p=>(p.box??null)===(box??null))||{}).qty||0;
const bx=(inv)=>inv.layout.boxes.filter(b=>!b.fixed);           // 忽略地面/正面墙这两个固定区
const total=(inv,id)=>(inv.items.find(i=>i.id===id).places||[]).reduce((s,p)=>s+p.qty,0);

t('建箱子',()=>{
  const r=applyOps(base,[{op:'addBox',box:{rack:'L1',level:2,slot:'c',label:'礼盒'}}]);
  eq(bx(r).length,1,'箱数'); eq(bx(r)[0].id,'L1-2-c','箱号');
  eq(bx(base).length,0,'不能改到原对象');
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
  eq(bx(r).length,0,'箱已删'); eq(qty(r,'001',null),27,'退回未归位');
});
t('删箱不重排其它槽位（保住实体标签）',()=>{
  const mid=applyOps(base,[{op:'addBox',box:{rack:'L1',level:1,slot:'a'}},{op:'addBox',box:{rack:'L1',level:1,slot:'b'}},{op:'addBox',box:{rack:'L1',level:1,slot:'c'}}]);
  const r=applyOps(mid,[{op:'delBox',id:'L1-1-b'}]);
  eq(bx(r).map(b=>b.id),['L1-1-a','L1-1-c'],'c 不能变成 b');
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
t('移箱：箱号跟着位置走，箱里的货不能丢',()=>{
  const mid=applyOps(base,[{op:'addBox',box:{rack:'L1',level:2,slot:'a',label:'礼盒'}},
    {op:'move',id:'001',from:null,to:'L1-2-a',qty:27},{op:'move',id:'002',from:null,to:'L1-2-a',qty:50}]);
  const r=applyOps(mid,[{op:'moveBox',id:'L1-2-a',rack:'R2',level:4,slot:'f'}]);
  eq(bx(r).map(b=>b.id),['R2-4-f'],'新箱号');
  eq(bx(r)[0].label,'礼盒','标签跟着走');
  eq(qty(r,'001','R2-4-f'),27,'001 跟着到新箱号');
  eq(qty(r,'002','R2-4-f'),50,'002 跟着到新箱号');
  eq(qty(r,'001','L1-2-a'),0,'旧箱号下没有残留');
  eq(total(r,'001'),27,'总数不变');
});
t('移箱到已占用的槽位被拒',()=>{
  const mid=applyOps(base,[{op:'addBox',box:{rack:'L1',level:1,slot:'a'}},{op:'addBox',box:{rack:'L1',level:1,slot:'b'}}]);
  let threw=false; try{applyOps(mid,[{op:'moveBox',id:'L1-1-a',rack:'L1',level:1,slot:'b'}])}catch(e){threw=e.message.includes('已经有箱子')}
  if(!threw)throw new Error('没拦住');
});
t('移箱到原位是空操作',()=>{
  const mid=applyOps(base,[{op:'addBox',box:{rack:'L1',level:1,slot:'a'}},{op:'move',id:'001',from:null,to:'L1-1-a',qty:5}]);
  const r=applyOps(mid,[{op:'moveBox',id:'L1-1-a',rack:'L1',level:1,slot:'a'}]);
  eq(bx(r).map(b=>b.id),['L1-1-a'],'箱号不变'); eq(qty(r,'001','L1-1-a'),5,'货不变');
});
t('移箱非法目标被拒',()=>{
  const mid=applyOps(base,[{op:'addBox',box:{rack:'L1',level:1,slot:'a'}}]);
  for(const o of [{rack:'XX',level:1,slot:'a'},{rack:'L1',level:9,slot:'a'},{rack:'L1',level:1,slot:'z'}]){
    let threw=false; try{applyOps(mid,[{op:'moveBox',id:'L1-1-a',...o}])}catch(e){threw=true}
    if(!threw)throw new Error('没拦住 '+JSON.stringify(o));
  }
});
t('拖拽落到空槽位：建箱+归位 一次提交',()=>{
  const r=applyOps(base,[{op:'addBox',box:{rack:'R1',level:3,slot:'b'}},{op:'move',id:'003',from:null,to:'R1-3-b',qty:33}]);
  eq(qty(r,'003','R1-3-b'),33,'落进新建的箱子'); eq(qty(r,'003',null),0,'未归位清空');
});
t('撤销一次拖拽能完全还原',()=>{
  const after=applyOps(base,[{op:'addBox',box:{rack:'R1',level:3,slot:'b'}},{op:'move',id:'003',from:null,to:'R1-3-b',qty:33}]);
  const undone=applyOps(after,[{op:'move',id:'003',from:'R1-3-b',to:null,qty:33},{op:'delBox',id:'R1-3-b'}]);
  eq(bx(undone).length,0,'箱子撤掉了');
  eq(qty(undone,'003',null),33,'货回到未归位');
  eq(JSON.stringify(undone.items),JSON.stringify(applyOps(base,[{op:'setBox',id:'x'}].slice(0,0)).items),'items 与初始一致');
});
t('地面/正面墙：能放货，但删不掉也挪不动',()=>{
  const r=applyOps(base,[{op:'move',id:'001',from:null,to:'G',qty:27},{op:'move',id:'002',from:null,to:'W',qty:50}]);
  eq(qty(r,'001','G'),27,'放到地面'); eq(qty(r,'002','W'),50,'放到正面墙');
  for(const [op,msg] of [[{op:'delBox',id:'G',force:true},'删不掉'],[{op:'moveBox',id:'W',rack:'L1',level:1,slot:'a'},'挪不动']]){
    let threw=false; try{applyOps(r,[op])}catch(e){threw=true}
    if(!threw)throw new Error('固定区域竟然可以'+msg);
  }
});
t('不分格的区里不能再建箱子',()=>{
  let threw=false;
  try{applyOps(base,[{op:'addBox',box:{rack:'G',level:1,slot:'b'}}])}catch(e){threw=e.message.includes('不分格子')}
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
