import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const {env:transformersEnv}=await import(process.env.QSTAGE+'/node_modules/@huggingface/transformers/dist/transformers.node.mjs');
const project=process.cwd(); const base=project;
if(process.env.AQE_EMBEDDER_ENDPOINT||process.env.AQE_EMBEDDER_TOKEN)throw Error('Endpoint must be unset for this in-process test');
if(path.resolve(process.env.AQE_MEMORY_PATH)!==path.join(project,'.agentic-qe/memory.db'))throw Error('Unexpected memory path');
if(transformersEnv.allowRemoteModels)throw Error('preload failed');
let attemptedFetches=0;globalThis.fetch=async()=>{attemptedFetches++;throw Error('Network fetch forbidden in offline runtime qualification');};
const {computeRealEmbedding,getActiveEmbeddingSpaceIdentity}=await import(process.env.QSTAGE+'/node_modules/agentic-qe/dist/learning/real-embeddings.js');
const {ReasoningBankService}=await import(process.env.QSTAGE+'/node_modules/agentic-qe/dist/mcp/services/reasoning-bank-service.js');
const {resetEmbedderIdentityStore}=await import(process.env.QSTAGE+'/node_modules/agentic-qe/dist/learning/embedder-identity-store.js');
const mode=process.argv[2];const expected='synthetic-transformers-profile-20261014';const text='Synthetic fixture: preserve database markers and project approval boundaries during local tooling configuration migration.';
let service;
try {
 const started=performance.now();const vector=await computeRealEmbedding(text);const elapsedMs=performance.now()-started;
 if(vector.length!==384||vector.some(v=>!Number.isFinite(v)))throw Error('Invalid embedding vector');
 const norm=Math.sqrt(vector.reduce((s,v)=>s+v*v,0));if(Math.abs(norm-1)>1e-4)throw Error('Embedding is not normalized');
 const identity=getActiveEmbeddingSpaceIdentity();if(identity?.provider!=='huggingface-transformers')throw Error('Unexpected embedding provider');
 service=await ReasoningBankService.create({enableExperienceReplay:false,enableTrajectories:false});
 if(mode==='store')await service.storeTaskPattern({taskId:expected,task:text,taskType:expected,domain:'test-generation',success:true,qualityScore:1,executionTimeMs:1});
 const matches=await service.searchPatternMatches('preserve database markers and approval boundaries in project tooling migration',{limit:10});const found=matches.find(m=>m.pattern?.name?.startsWith(expected));
 const require=createRequire(process.env.QSTAGE+'/node_modules/agentic-qe/package.json');
 const result={mode,syntheticOnly:true,dimension:vector.length,norm,coldEmbeddingMs:Math.round(elapsedMs),identity,expectedPatternFound:!!found,patternId:found?.pattern?.id,similarity:found?.similarity,attemptedFetches,remoteModelsAllowed:transformersEnv.allowRemoteModels,endpointConfigured:false,transformersResolvedFromAqe:require.resolve('@huggingface/transformers'),stats:await service.getStats()};
 fs.writeFileSync(path.join(base,'transformers-'+mode+'-result.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({mode,dimension:result.dimension,embeddingProvider:identity.provider,expectedPatternFound:!!found,patternId:result.patternId,coldEmbeddingMs:result.coldEmbeddingMs,attemptedFetches}));
 if(!found)process.exitCode=2;
}finally{await service?.dispose();resetEmbedderIdentityStore();}
