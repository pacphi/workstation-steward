import {test,before,after} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import crypto from 'node:crypto';
const {createMemoryBackend}=await import(process.env.QSTAGE+'/node_modules/agentic-qe/dist/kernel/memory-factory.js');
const base=new URL('.',import.meta.url).pathname;const fixture=JSON.parse(fs.readFileSync(base+'fixture.json','utf8'));const mode='baseline';
const module=mode==='candidate'?new URL('./learning-coordinator.candidate.mjs',import.meta.url).href:'file://'+process.env.QSTAGE+'/node_modules/agentic-qe/dist/domains/learning-optimization/services/learning-coordinator.js';
const {LearningCoordinatorService}=await import(module);const ns={namespace:'learning-optimization'};let memory,service;
before(async()=>{({backend:memory}=await createMemoryBackend({type:'sqlite',sqlite:{path:fixture.db,walMode:true}},true));service=new LearningCoordinatorService({memory},{enableLLMSynthesis:false});});after(async()=>{await memory?.dispose();});
function value(result){if(!result.success)throw result.error;return result.value;}
test('should retrieve the learned active pattern with tag filtering',async()=>{assert.deepEqual(value(await service.findMatchingPatterns({tags:['synthetic-fixture-only']})).map(p=>p.id),[fixture.activePatternId]);});
test('should exclude archives, provenance and malformed rows without tag filtering',async()=>{assert.deepEqual(value(await service.findMatchingPatterns({tags:[]})).map(p=>p.id),[fixture.activePatternId]);});
test('should return no patterns for a nonmatching tag',async()=>{assert.deepEqual(value(await service.findMatchingPatterns({tags:['unrelated-tag']})),[]);});
test('should return no patterns for a nonmatching language',async()=>{assert.deepEqual(value(await service.findMatchingPatterns({language:'python',tags:[]})),[]);});
test('should honor the requested result limit',async()=>{assert.deepEqual(value(await service.findMatchingPatterns({tags:[]},0)),[]);});
test('should count only active patterns in unscoped statistics',async()=>{assert.equal(value(await service.getPatternStats()).totalPatterns,1);});
test('should keep unscoped aggregate confidence finite',async()=>{assert.equal(Number.isFinite(value(await service.getPatternStats()).avgConfidence),true);});
test('should count only active patterns in domain-scoped statistics',async()=>{assert.equal(value(await service.getPatternStats('code-intelligence')).totalPatterns,1);});
test('should preserve all learned, archived, provenance and malformed records',async()=>{const keys=(await memory.search('learning:pattern:*',1000,ns)).sort();const records=[];for(const key of keys)records.push([key,await memory.get(key,ns)]);assert.equal(crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex'),fixture.recordsSha256);});
