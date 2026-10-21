import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

async function harness(t) {
  const app=createApp({dbPath:':memory:',secret:'test-secret'});
  await new Promise(resolve=>app.server.listen(0,resolve));
  t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;
  return async (path,method='GET',body,token) => {
    const r=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
    return {status:r.status,data:await r.json()};
  };
}

test('registration, membership authorization and optimistic locking',async t=>{
  const api=await harness(t);
  const a=await api('/api/auth/register','POST',{name:'A',email:'a@example.com',password:'abcdefgh'});
  const b=await api('/api/auth/register','POST',{name:'B',email:'b@example.com',password:'abcdefgh'});
  assert.equal(a.status,201);
  const unauth=await api('/api/workspaces'); assert.equal(unauth.status,401);
  const w=await api('/api/workspaces','POST',{name:'Engineering'},a.data.token); assert.equal(w.status,201);
  const denied=await api(`/api/workspaces/${w.data.id}/boards`,'GET',undefined,b.data.token); assert.equal(denied.status,403);
  assert.equal((await api(`/api/workspaces/${w.data.id}/members`,'POST',{email:'b@example.com'},a.data.token)).status,201);
  const board=(await api(`/api/workspaces/${w.data.id}/boards`,'GET',undefined,b.data.token)).data.boards[0];
  const task=await api(`/api/boards/${board.id}/tasks`,'POST',{title:'Write tests',assignee_id:b.data.user.id},a.data.token); assert.equal(task.status,201);
  const changed=await api(`/api/tasks/${task.data.task.id}`,'PATCH',{status:'DONE',version:1},b.data.token);assert.equal(changed.status,200);assert.equal(changed.data.task.version,2);
  assert.equal((await api(`/api/tasks/${task.data.task.id}`,'PATCH',{status:'REVIEW',version:1},a.data.token)).status,409);
  const metrics=await api(`/api/workspaces/${w.data.id}/metrics`,'GET',undefined,a.data.token);assert.deepEqual(metrics.data.summary,[{status:'DONE',count:1}]);
});
