import assert from 'node:assert/strict'
import test from 'node:test'
import { meetingTodoFieldChanges } from './delivery-meeting-todo-field-changes.ts'

type Row = { id:string; sourceRow:number; sequence?:number|null; establishedDate?:string|null; title:string; dueDate?:string|null; deadlineText?:string|null; projectId?:string|null; projectNameRaw?:string|null }
function row(id:string, sourceRow:number, extra:Partial<Row>={}):Row{ return { id, sourceRow, sequence:null, establishedDate:null, title:'', dueDate:null, deadlineText:null, projectId:null, projectNameRaw:null, ...extra } }

test('sequence+title matches the same todo and reports establishedDate and deadline changes with displays', () => {
  const previous=[row('p1',2,{sequence:1,title:'推进接口联调',establishedDate:'2026-09-01',dueDate:'2026-09-05',projectId:'proj-1'})]
  const current=[row('c1',2,{sequence:1,title:'推进接口联调',establishedDate:'2026-09-03',dueDate:'2026-09-10',projectId:'proj-1'})]
  const changes=meetingTodoFieldChanges(current,previous)
  assert.deepEqual(changes.get('c1'),[
    {field:'establishedDate',label:'建立时间',oldDisplay:'2026-09-01',newDisplay:'2026-09-03'},
    {field:'deadline',label:'截止/节点',oldDisplay:'2026-09-05',newDisplay:'2026-09-10'},
  ])
})

test('same sequence with different title and different project is treated as sheet drift, not a match', () => {
  const previous=[row('p1',2,{sequence:2,title:'旧事项',projectId:'proj-1'})]
  const current=[row('c1',2,{sequence:2,title:'新事项',projectId:'proj-2',establishedDate:'2026-09-09',dueDate:'2026-09-09'})]
  const changes=meetingTodoFieldChanges(current,previous)
  assert.equal(changes.size,0)
})

test('missing sequence falls back to normalized title plus compatible project', () => {
  const previous=[row('p1',3,{title:'推进验收准备',projectId:'proj-1',deadlineText:'持续推进'})]
  const current=[row('c1',3,{title:'推进，验收准备',projectId:'proj-1',dueDate:'2026-09-30'})]
  const changes=meetingTodoFieldChanges(current,previous)
  assert.deepEqual(changes.get('c1'),[{field:'deadline',label:'截止/节点',oldDisplay:'持续推进',newDisplay:'2026-09-30'}])
})

test('identical title under a different project never matches (project guard)', () => {
  const previous=[row('p1',4,{title:'推进验收准备',projectId:'proj-1',deadlineText:'持续推进'})]
  const current=[row('c1',4,{title:'推进验收准备',projectId:'proj-2',deadlineText:'2026-10-01'})]
  assert.equal(meetingTodoFieldChanges(current,previous).size,0)
})

test('deadline view prefers dueDate so equivalent spellings are not reported as changes', () => {
  const previous=[row('p1',5,{sequence:1,title:'事项A',dueDate:'2026-09-02',deadlineText:'2026-9-2',establishedDate:'2026-09-01'})]
  const current=[row('c1',5,{sequence:1,title:'事项A',dueDate:'2026-09-02',deadlineText:'2026年9月2日',establishedDate:'2026-09-01'})]
  assert.equal(meetingTodoFieldChanges(current,previous).size,0)
  const textOnlyPrevious=[row('p2',6,{title:'事项B',deadlineText:'2026年9月2日'})]
  const textOnlyCurrent=[row('c2',6,{title:'事项B',deadlineText:'2026-09-02'})]
  assert.equal(meetingTodoFieldChanges(textOnlyCurrent,textOnlyPrevious).size,0)
})

test('each previous todo is matched at most once and only changed fields are reported', () => {
  const previous=[row('p1',7,{sequence:3,title:'重复事项',projectId:'proj-1',establishedDate:'2026-09-01'})]
  const current=[
    row('c1',7,{sequence:3,title:'重复事项',projectId:'proj-1',establishedDate:'2026-09-01',deadlineText:'2026-10-01'}),
    row('c2',8,{sequence:3,title:'重复事项',projectId:'proj-1',establishedDate:'2026-09-05'}),
  ]
  const changes=meetingTodoFieldChanges(current,previous)
  assert.deepEqual(changes.get('c1'),[{field:'deadline',label:'截止/节点',oldDisplay:null,newDisplay:'2026-10-01'}])
  assert.equal(changes.has('c2'),false)
})

test('project compatibility compares ids when both matched, raw names otherwise (never id vs name)', () => {
  const previous=[row('p1',4,{title:'推进验收准备',projectId:null,projectNameRaw:'罗山科技园',deadlineText:'持续推进'})]
  const current=[row('c1',4,{title:'推进验收准备',projectId:'proj-9',projectNameRaw:'罗山科技园',deadlineText:'2026-10-01'})]
  const changes=meetingTodoFieldChanges(current,previous)
  assert.deepEqual(changes.get('c1'),[{field:'deadline',label:'截止/节点',oldDisplay:'持续推进',newDisplay:'2026-10-01'}])
  const suffix=[row('p2',5,{title:'推进验收准备',projectId:null,projectNameRaw:'罗山科技园项目'})]
  const suffixCurrent=[row('c2',5,{title:'推进验收准备',projectId:null,projectNameRaw:'罗山科技园',deadlineText:'2026-11-01'})]
  assert.equal(meetingTodoFieldChanges(suffixCurrent,suffix).size,1)
  const differentRaw=[row('p3',6,{title:'推进验收准备',projectId:null,projectNameRaw:'龙岗区两办辅政'})]
  const differentRawCurrent=[row('c3',6,{title:'推进验收准备',projectId:null,projectNameRaw:'罗山科技园',deadlineText:'2026-11-01'})]
  assert.equal(meetingTodoFieldChanges(differentRawCurrent,differentRaw).size,0)
})

test('empty displays become null and an absent previous batch yields no changes', () => {
  const changes=meetingTodoFieldChanges([row('c1',9,{title:'事项C',establishedDate:'2026-09-03',projectId:'proj-1'})],[])
  assert.equal(changes.size,0)
  const nullToValue=meetingTodoFieldChanges(
    [row('c1',9,{sequence:1,title:'事项C',establishedDate:'2026-09-03'})],
    [row('p1',9,{sequence:1,title:'事项C',establishedDate:null})],
  )
  assert.deepEqual(nullToValue.get('c1'),[{field:'establishedDate',label:'建立时间',oldDisplay:null,newDisplay:'2026-09-03'}])
})
