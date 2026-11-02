import { describe,it,expect,vi } from 'vitest';
import { aiConnection,teamBinding } from '@/lib/team-models';
vi.mock('@/lib/crypto.server',()=>({decryptSecret:vi.fn(async (cipher:string)=>`key-${cipher}`)}));
vi.mock('@/lib/providers.server',()=>({assertPublicEndpoint:vi.fn(),createModel:vi.fn((provider,key,base,model)=>({provider,key,base,model}))}));
import {loadTeamModels} from '@/lib/team-models.server';
const session = {credential_id:'lead',model:'gpt-4.1',coding_credential_id:'code',coding_model:'claude-sonnet-4',reviewer_credential_id:'review',reviewer_model:'gemini-2.5-pro'};
describe('multi-API project teams',()=>{
 it('routes simultaneous role models to their selected API connections',()=>{
  expect(teamBinding('frontend',session)).toMatchObject({credentialId:'code',model:'claude-sonnet-4'});
  expect(teamBinding('security',session)).toMatchObject({credentialId:'review',model:'gemini-2.5-pro'});
  expect(teamBinding('architect',session)).toMatchObject({credentialId:'lead',model:'gpt-4.1'});
 });
 it('inherits the lead only when no separate connection is pinned',()=>{
  expect(teamBinding('backend',{credential_id:'lead',model:'gpt-4.1',coding_model:'gpt-4.1-mini'})).toMatchObject({credentialId:'lead',model:'gpt-4.1-mini'});
 });
 it('requires a model for a separate API',()=>{expect(()=>teamBinding('coder',{...session,coding_model:null})).toThrow('Choose a model');});
 it('does not permit service tokens as AI connections',()=>{expect(aiConnection('vercel')).toBe(false);expect(aiConnection('anthropic')).toBe(true);});
 const client=(missing=false)=>({from:()=>{
  const filters:Record<string,string>={};
  const q={select:()=>q,eq:(key:string,value:string)=>{filters[key]=value;return q;},maybeSingle:async()=>{
   expect(filters["user_id"]).toBe('owner');
   return {data:missing && filters["id"]==='code'?null:{provider:filters["id"]==='code'?'anthropic':filters["id"]==='review'?'google':'openai',ciphertext:filters["id"],iv:'iv',base_url:null},error:null};
  }};return q;
 }});
 it('resolves multiple encrypted owner keys without mixing providers',async()=>{
  const route=await loadTeamModels(client(),'owner',session);
  const result=await Promise.all(['coder','reviewer','architect'].map(async role=>route(role)));
  expect(result.map(r=>r.provider)).toEqual(['anthropic','google','openai']);
  expect(result[0]?.model).toMatchObject({key:'key-code',model:'claude-sonnet-4'});
  expect(result[1]?.model).toMatchObject({key:'key-review',model:'gemini-2.5-pro'});
 });
 it('stops on a missing pinned connection instead of falling back',async()=>{await expect(loadTeamModels(client(true),'owner',session)).rejects.toThrow('missing or unavailable');});
});