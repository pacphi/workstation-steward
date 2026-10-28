import fs from 'node:fs';import crypto from 'node:crypto';
const {createMemoryBackend}=await import(process.env.QSTAGE+'/node_modules/agentic-qe/dist/kernel/memory-factory.js');
const {LearningCoordinatorService}=await import(process.env.QSTAGE+'/node_modules/agentic-qe/dist/domains/learning-optimization/services/learning-coordinator.js');
const base=new URL('.',import.meta.url).pathname;const ns={namespace:'learning-optimization'};const db=base+'.agentic-qe/memory.db';if(fs.existsSync(db))throw Error('Refusing to overwrite seeded fixture');
const {backend:memory}=await createMemoryBackend({type:'sqlite',sqlite:{path:db,walMode:true}},true);
try {
 const service=new LearningCoordinatorService({memory},{enableLLMSynthesis:false});const oldIds=[];
 for(let batch=0;batch<2;batch++){
  const experiences=Array.from({length:5},(_,i)=>({id:`synthetic-${batch}-${i}`,agentId:{value:'synthetic-private-fix-test'},domain:'code-intelligence',action:'preserve-fixture-state',state:{context:{language:'javascript',framework:'vitest',testType:'integration',tags:['synthetic-fixture-only']},metrics:{}},result:{success:true,outcome:{synthetic:true},duration:1},reward:1,timestamp:new Date()}));
  const learned=await service.learnPattern(experiences);if(!learned.success)throw learned.error;oldIds.push(learned.value.id);
 }
 const merged=await service.consolidatePatterns(oldIds);if(!merged.success)throw merged.error;
 await memory.set('learning:pattern:malformed-no-context',{id:'malformed-no-context',domain:'code-intelligence'},{...ns,persist:true});
 await memory.set('learning:pattern:malformed-tags',{id:'malformed-tags',context:{tags:null},domain:'code-intelligence'},{...ns,persist:true});
 const keys=(await memory.search('learning:pattern:*',1000,ns)).sort();const records=[];for(const key of keys)records.push([key,await memory.get(key,ns)]);
 const result={syntheticOnly:true,db,activePatternId:merged.value.id,archivedPatternIds:oldIds,recordCount:keys.length,recordsSha256:crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex')};
 fs.writeFileSync(base+'fixture.json',JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({seeded:keys.length,activePatterns:1,archivedPatterns:2,provenanceRows:2,malformedRows:2}));
}finally{await memory.dispose();}
