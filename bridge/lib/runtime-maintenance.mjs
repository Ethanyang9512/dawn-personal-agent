import fs from 'node:fs';
import path from 'node:path';

import { writeDurableJson, readDurableJson } from './durable-json.mjs';
import { processIdentity } from './durable-chat.mjs';

export const requestMetadata = options => ({ schemaVersion:2, createdAt:Date.now(), model:options.model, effort:options.effort });

// Keep the interrupted caller stopped until its exact state is durable. No new polling or sends.
export function saveWithRetry(file, value, { write=writeDurableJson, wait=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms), onFailure=()=>{} }={}) {
  let attempts=0;
  for (;;) {
    try { write(file,value); return {attempts:attempts+1}; }
    catch(error) {
      if (!attempts) { try { onFailure(error); } catch {} }
      wait(Math.min(30000,1000*2**Math.min(attempts++,5)));
    }
  }
}

function archiveRun(directory) {
  const archive = path.join(path.dirname(path.dirname(directory)), 'retired-runs');
  fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
  fs.renameSync(directory, path.join(archive, path.basename(directory)));
}
export function cleanChatRuns(root, state, {now=Date.now(), trash=archiveRun, alive=claim=>claim?.start&&processIdentity(claim.pid)===claim.start}={}) {
  const protectedIds=new Set(Object.values(state.jobs||{}).map(x=>x.runId));
  for(const x of Object.values(state.inbox||{}))if(!['done','cancelled'].includes(x.status))protectedIds.add(x.jobId);
  for(const x of [...Object.values(state.outbox||{}).flat(),...Object.values(state.users||{}).flatMap(u=>u.staleProactive||[])])protectedIds.add(x.runId);
  let removed=0,redacted=0;
  for(const item of fs.existsSync(root)?fs.readdirSync(root,{withFileTypes:true}):[]) {
    const match=item.name.match(/^([\da-f]{8}-[\da-f-]{27})-\d+$/i);
    if(!item.isDirectory()||!match||protectedIds.has(match[1]))continue;
    const dir=path.join(root,item.name), inputs=Object.values(state.inbox||{}).filter(x=>x.jobId===match[1]);
    if(!inputs.length||inputs.some(x=>!['done','cancelled'].includes(x.status)))continue;
    try {
      if(alive(readDurableJson(path.join(dir,'claim.json'),null))||!fs.existsSync(path.join(dir,'result.json')))continue;
      const latest=Math.max(...inputs.map(x=>x.finishedAt||now),...fs.readdirSync(dir).filter(n=>n!=='request.json').map(n=>fs.lstatSync(path.join(dir,n)).mtimeMs));
      if(latest<now-14*864e5){trash(dir);removed++;continue;}
      const request=path.join(dir,'request.json'), metadata=readDurableJson(request,null);
      if(metadata&&metadata.schemaVersion!==2){writeDurableJson(request,requestMetadata(metadata));redacted++;}
    } catch(error) { if(error.code!=='ENOENT')throw error; }
  }
  return {removed,redacted};
}
