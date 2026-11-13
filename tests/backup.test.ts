import { expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../deploy/bottle-backup.sh', import.meta.url), 'utf8');
const code = source.match(/"\$NODE" -e '([\s\S]*?)' "\$DATA" "\$OUT"/)![1];
function fixture(run: (input: string, output: string, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'bottle-backup-'));
  try { run(join(dir,'db.json'),join(dir,'backup.json'),dir); }
  finally { rmSync(dir,{recursive:true,force:true}); }
}
it('long-lived backups strip text, SVG and notes while retaining identity, quota and receipts',()=>fixture((input,output)=>{
  const doc={version:3,bots:[{clientHash:'test',bottlesUsed:2}],letters:[{id:'l',body:'PRIVATE LETTER',topic:'PRIVATE TITLE',stationery:{v:1,customSvg:'PRIVATE SVG'}}],replies:[{id:'r',body:'PRIVATE REPLY',stationery:{v:1,customSvg:'PRIVATE REPLY SVG'}}],notes:[{id:'n',body:'PRIVATE PAPER'}],noteReceipts:[{id:'n',expiresAt:123}]};
  writeFileSync(input,JSON.stringify(doc));
  const ran=spawnSync(process.execPath,['-e',code,input,output],{encoding:'utf8'});
  expect(ran.status,ran.stderr).toBe(0);
  const text=readFileSync(output,'utf8'),saved=JSON.parse(text);
  expect(text).not.toContain('PRIVATE');expect(text).not.toContain('stationery');
  expect(saved.notes).toEqual([]);expect(saved.bots).toEqual(doc.bots);expect(saved.noteReceipts).toEqual(doc.noteReceipts);
  expect(JSON.parse(readFileSync(input,'utf8'))).toEqual(doc);
}));
it('invalid source never overwrites a previous valid backup',()=>fixture((input,output,dir)=>{
  writeFileSync(input,'{bad');writeFileSync(output,'{"valid":true}');
  expect(spawnSync(process.execPath,['-e',code,input,output]).status).not.toBe(0);
  expect(readFileSync(output,'utf8')).toBe('{"valid":true}');
  expect(readdirSync(dir).some(n=>n.includes('.tmp-'))).toBe(false);
}));
it('partial write failure preserves the prior backup and cleans the incomplete temporary file',()=>fixture((input,output,dir)=>{
  writeFileSync(input,'{"bots":[],"letters":[],"replies":[]}');writeFileSync(output,'{"valid":true}');
  const fault='{ const fs=require("node:fs"),write=fs.writeFileSync; fs.writeFileSync=(path,...args)=>{write(path,"{",args[1]);throw Error("injected disk full");}; }\n';
  expect(spawnSync(process.execPath,['-e',fault+code,input,output]).status).not.toBe(0);
  expect(readFileSync(output,'utf8')).toBe('{"valid":true}');
  expect(readdirSync(dir).some(n=>n.includes('.tmp-'))).toBe(false);
}));
