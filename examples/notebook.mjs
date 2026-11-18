import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { annotateConversations, captureConversation, rebuildConversations } from '../bridge/lib/conversation-memory.mjs';
import { maintainNotebook, notebookBrief, readNotebook, saveDraft } from '../bridge/lib/dawn-notebook.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'dawn-book-demo-')));
const options = {
  memoryDir: path.join(root,'memory'),
  journalPath: path.join(root,'state','memory-transaction.json'),
  indexPath: path.join(root,'state','conversations.sqlite'),
  vaultDir: path.join(root,'vault'),
};
const topic = '图册装订';
const notes = [
  {day:'01', text:'图册用线装，打开以后能平摊在桌面上。', terms:['线装','平摊']},
  {day:'03', text:'把那张长幅的折页放在最后，展开时就不会遮住前面的图。', terms:['折页','长幅']},
];
const sources = notes.map(({day,text,terms}) => {
  const row = captureConversation({sourceId:'book-'+day,role:'user',at:`2026-01-${day}T10:00:00Z`,text},options);
  annotateConversations([{id:row.id,quote:text,topic,terms,kind:'idea',summary:text}],options);
  return row.id;
});
assert.equal(rebuildConversations(options).records,2);
const directory = notebookBrief({mode:'clues'},options);
assert.equal(directory.topics[0].topic,topic);
const {items} = notebookBrief({mode:'clues',topic},options);
assert.deepEqual(items.map(row=>row.id).sort(),sources.slice().sort());
maintainNotebook(options);

const draft = {id:'booklet',title:'图册制作说明',text:'图册采用能摊平的线装。',sources};
saveDraft({...draft,expectedSha256:null},options);
const first = readNotebook('draft:booklet',options);
saveDraft({...draft,text:draft.text+'长幅折页放在册末。',expectedSha256:first.sha256},options);
const current = readNotebook('draft:booklet',options);
assert.equal(current.revision,2);
assert.equal(current.history.length,1);
assert.ok(fs.existsSync(current.history[0].path));
assert.deepEqual(current.sources.map(s=>s.id),sources);

for (const record of items) console.log(record.date,record.text);
console.log('草稿版本',current.revision,'历史版本',current.history.length);
console.log('Obsidian 知识库',options.vaultDir);
