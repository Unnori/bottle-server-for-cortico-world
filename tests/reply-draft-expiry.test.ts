import { expect, it } from 'vitest';
import { createApi, sha256 } from '../server/app.ts';
import { Db } from '../server/db.ts';
import { DEFAULT_TUNING } from '../server/tuning.ts';
import { REPLY_AUTO_SEND_MS, REPLY_DRAFT_RETRY_GRACE_MS } from '../shared/contract.ts';

const HOUR=3_600_000;
function rig(windowHours=24) {
  const clock={t:Date.parse('2026-11-08T08:00:00+08:00')};const db=Db.open(null);let seq=0;
  const api=createApi(db,{now:()=>clock.t,timeZone:'Asia/Hong_Kong',random:()=>0,newToken:()=>`token_${++seq}`,ipLimit:100,
    tuning:{current:()=>({...DEFAULT_TUNING,replyWindowHours:windowHours})},
    rules:{sendBase:50,sendCap:50,catchBase:50,catchCap:50,poolDivisor:5,replyCap:50}});
  const call=(path:string,token?:string,body?:unknown)=>api.handle({method:body===undefined?'GET':'POST',path,token,body,ip:'test'});
  const register=(name:string)=>(call('/register',undefined,{hash:sha256(name)}).body as {token:string}).token;
  const a=register('author'),b=register('holder'),c=register('next');
  const id=(call('/throw',a,{body:'原信正文仍在内存。'}).body as {letterId:string}).letterId;
  call('/catch',b,{});const row=db.letterById(id)!;
  const reserve=(key='pending')=>call('/reply/draft',b,{letterId:id,draftKey:key});
  return {clock,db,call,a,b,c,id,row,reserve};
}

it('reclaims the reported November 8 letter with window 80h overdue and draft 102h overdue, preserving its body',()=>{
  const h=rig();expect(h.reserve().status).toBe(200);h.clock.t+=104*HOUR;
  expect(h.clock.t-h.row.replyWindowUntil!).toBe(80*HOUR);
  expect(h.clock.t-h.row.replyDraftDueAt!).toBe(102*HOUR);
  h.call('/quota',h.b);
  expect(h.row).toMatchObject({state:'floating',catcherHash:null,caughtAt:null,replyWindowUntil:null,body:'原信正文仍在内存。',throws:0});
  expect(h.row.replyDraftKey).toBeUndefined();expect(h.row.replyDraftDueAt).toBeUndefined();
  expect(h.call('/catch',h.c,{}).body).toMatchObject({empty:false,letterId:h.id});
  h.db.bots.find(bot=>bot.clientHash===sha256('holder'))!.repliesMade=999;
  expect(h.call('/reply',h.b,{letterId:h.id,draftKey:'pending',body:'过时回信'}).status).toBe(404);
  expect(h.db.replies).toHaveLength(0);
});

it('preserves normal deadline sending and finite retries, including a lost reservation response',()=>{
  const h=rig();h.clock.t+=23*HOUR;expect(h.reserve().status).toBe(200);const due=h.row.replyDraftDueAt!;
  h.clock.t=due;h.call('/quota',h.b);expect(h.row.state).toBe('caught');
  h.clock.t=due+HOUR;expect(h.reserve().body).toMatchObject({sendAt:new Date(due).toISOString()});
  h.row.body=''; // Server restart may retain pending metadata, never either body.
  expect(h.call('/reply',h.b,{letterId:h.id,draftKey:'pending',body:'迟到一小时的回信。'}).status).toBe(200);
  expect(h.row.state).toBe('replied');expect(h.row.replyDraftKey).toBeUndefined();
});

it('expires at the retry boundary without waiting for the holder or a quota/catch request',()=>{
  const h=rig();h.clock.t+=23*HOUR;h.reserve();const due=h.row.replyDraftDueAt!;
  h.clock.t=due+REPLY_DRAFT_RETRY_GRACE_MS-1;h.call('/health');expect(h.row.replyDraftKey).toBe('pending');
  h.clock.t++;h.call('/health');expect(h.row.state).toBe('floating');expect(h.row.replyDraftKey).toBeUndefined();
});

it('clears expired protection but respects a later original return window',()=>{
  const h=rig(72);h.reserve();h.clock.t+=REPLY_AUTO_SEND_MS+REPLY_DRAFT_RETRY_GRACE_MS;
  h.call('/quota',h.b);expect(h.row.state).toBe('caught');expect(h.row.replyDraftKey).toBeUndefined();expect(h.row.replyDraftDueAt).toBeUndefined();
  h.clock.t=h.row.replyWindowUntil!;h.call('/health');expect(h.row.state).toBe('floating');
});

it.each([undefined,0,-1,NaN,Infinity,'invalid'] as unknown[])('removes a marker with invalid due time %s instead of protecting forever',due=>{
  const h=rig();h.row.replyDraftKey='broken';h.row.replyDraftDueAt=due as number;h.clock.t+=25*HOUR;
  h.call('/quota',h.b);expect(h.row.state).toBe('floating');expect(h.row.replyDraftKey).toBeUndefined();expect(h.row.replyDraftDueAt).toBeUndefined();
});

it('cleans an expired legacy null-window marker and archives bodyless letters rather than floating zombies',()=>{
  const h=rig();h.reserve();h.row.replyWindowUntil=null;h.row.body='';h.clock.t+=100*HOUR;
  h.call('/health');expect(h.row).toMatchObject({state:'archived',archivedReason:'empty',catcherHash:null});expect(h.row.replyDraftKey).toBeUndefined();
});

it('does not replace another active draft key or extend its confirmed deadline',()=>{
  const h=rig();h.reserve();const due=h.row.replyDraftDueAt;h.clock.t+=HOUR;
  expect(h.reserve('replacement').status).toBe(409);expect(h.row.replyDraftKey).toBe('pending');expect(h.row.replyDraftDueAt).toBe(due);
});
