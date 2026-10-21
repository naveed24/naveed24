import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

async function harness(t) {
  const app=createApp({dbPath:':memory:',secret:'test-secret',adminEmail:'admin@demo.com',adminPassword:'securePassword123'});
  await new Promise(resolve=>app.server.listen(0,resolve));t.after(()=>app.close());
  const base=`http://127.0.0.1:${app.server.address().port}`;
  return async(path,method='GET',body,token,key)=>{
    const r=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{}),...(key?{'Idempotency-Key':key}:{})},body:body?JSON.stringify(body):undefined});
    return {status:r.status,data:await r.json()};
  };
}

test('order lifecycle, idempotent checkout, role enforcement and stock restoration',async t=>{
  const api=await harness(t);
  const c=await api('/api/auth/register','POST',{name:'Customer',email:'buyer@demo.com',password:'12345678'});
  const admin=await api('/api/auth/login','POST',{email:'admin@demo.com',password:'securePassword123'});
  const product=(await api('/api/products')).data.products[0];
  assert.equal((await api('/api/admin/analytics','GET',undefined,c.data.token)).status,403);
  const payload={items:[{product_id:product.id,quantity:2}]};
  const order=await api('/api/orders','POST',payload,c.data.token,'checkout-01');assert.equal(order.status,201);
  assert.equal(order.data.order.total_cents,product.price_cents*2);
  const repeat=await api('/api/orders','POST',payload,c.data.token,'checkout-01');assert.equal(repeat.status,200);assert.equal(repeat.data.replayed,true);
  assert.equal(repeat.data.order.id,order.data.order.id);
  assert.equal((await api('/api/products')).data.products.find(x=>x.id===product.id).stock,product.stock-2);
  const cancelled=await api(`/api/admin/orders/${order.data.order.id}/status`,'PATCH',{status:'CANCELLED'},admin.data.token);
  assert.equal(cancelled.status,200);
  assert.equal((await api('/api/products')).data.products.find(x=>x.id===product.id).stock,product.stock);
  assert.equal((await api(`/api/admin/orders/${order.data.order.id}/status`,'PATCH',{status:'FULFILLED'},admin.data.token)).status,409);
  const analytics=await api('/api/admin/analytics','GET',undefined,admin.data.token);assert.equal(analytics.data.summary.revenue_cents,0);
});

test('prevents overselling and leaves inventory unchanged on failure',async t=>{
  const api=await harness(t);
  const c=await api('/api/auth/register','POST',{name:'Customer',email:'buyer2@demo.com',password:'12345678'});
  const product=(await api('/api/products')).data.products[0];
  const error=await api('/api/orders','POST',{items:[{product_id:product.id,quantity:product.stock+1}]},c.data.token,'overflow');
  assert.equal(error.status,409);
  assert.equal((await api('/api/products')).data.products.find(x=>x.id===product.id).stock,product.stock);
});
