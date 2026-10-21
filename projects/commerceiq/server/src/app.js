import { createServer as createHttpServer } from 'node:http';
import { database, id, now, passwordHash, passwordVerify, signToken, tokenUser, bodyJson, json, apiServer, string, email, assert, ApiError } from './lib.js';

export function createApp({ dbPath=process.env.DB_PATH || './data/commerceiq.sqlite', secret=process.env.TOKEN_SECRET || 'local-dev-secret-change-for-production', adminEmail=process.env.ADMIN_EMAIL, adminPassword=process.env.ADMIN_PASSWORD } = {}) {
  const db=database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('CUSTOMER','ADMIN')));
    CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL CHECK(price_cents>=0), stock INTEGER NOT NULL CHECK(stock>=0), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('PLACED','FULFILLED','CANCELLED')), total_cents INTEGER NOT NULL, idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(user_id,idempotency_key));
    CREATE TABLE IF NOT EXISTS order_items(order_id TEXT NOT NULL REFERENCES orders(id), product_id TEXT NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL CHECK(quantity>0), unit_price_cents INTEGER NOT NULL, PRIMARY KEY(order_id,product_id));
    CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id,created_at);
    CREATE INDEX IF NOT EXISTS idx_products_active_category ON products(active,category);
  `);
  if (adminEmail && adminPassword) {
    const e=email(adminEmail);
    if (!db.prepare('SELECT id FROM users WHERE email=?').get(e)) {
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(id(),'Store Administrator',e,passwordHash(adminPassword),'ADMIN');
    }
  }
  const initialCount=db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  if (initialCount===0) {
    const seed=[
      ['Wireless Headphones','Electronics','Over-ear wireless headphones',7999,30],
      ['Mechanical Keyboard','Electronics','Hot-swappable mechanical keyboard',10999,24],
      ['Everyday Backpack','Lifestyle','Water-resistant commuter backpack',5499,40],
      ['Desk Lamp','Home','Adjustable LED desk lamp',3499,45],
      ['Ceramic Coffee Set','Home','Set of four ceramic coffee mugs',2899,35],
      ['Notebook Collection','Stationery','Three premium ruled notebooks',1499,70],
      ['USB-C Hub','Electronics','Multiport USB-C hub',4599,25],
      ['Minimalist Watch','Lifestyle','Classic analogue wristwatch',12999,12]
    ];
    const stmt=db.prepare('INSERT INTO products VALUES (?,?,?,?,?,?,?,?)');
    for (const p of seed) stmt.run(id(),...p,1,now());
  }
  function adminOnly(user) { assert(user.role==='ADMIN',403,'Administrator required'); }
  function presentOrder(oid) {
    const order=db.prepare('SELECT * FROM orders WHERE id=?').get(oid);
    return { ...order, items: db.prepare(`SELECT i.product_id,p.name,i.quantity,i.unit_price_cents FROM order_items i JOIN products p ON p.id=i.product_id WHERE i.order_id=?`).all(oid) };
  }
  async function handler(req,res,path) {
    const m=req.method;
    if (m==='GET' && path==='/api/health') return json(res,200,{status:'ok',service:'commerceiq'});
    if (m==='POST' && path==='/api/auth/register') {
      const input=await bodyJson(req);
      const user={id:id(),name:string(input.name,'Name',80),email:email(input.email),role:'CUSTOMER'};
      assert(!db.prepare('SELECT id FROM users WHERE email=?').get(user.email),409,'Email already registered');
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(user.id,user.name,user.email,passwordHash(input.password),user.role);
      return json(res,201,{user,token:signToken(user,secret)});
    }
    if (m==='POST' && path==='/api/auth/login') {
      const input=await bodyJson(req);const found=db.prepare('SELECT * FROM users WHERE email=?').get(email(input.email));
      assert(found && passwordVerify(input.password,found.password_hash),401,'Invalid credentials');
      const {password_hash,...user}=found;return json(res,200,{user,token:signToken(user,secret)});
    }
    if(m==='GET' && path==='/api/products') {
      const products=db.prepare('SELECT id,name,category,description,price_cents,stock,active FROM products WHERE active=1 ORDER BY category,name').all();
      return json(res,200,{products});
    }
    const user=tokenUser(req,db,secret);
    if (m==='GET' && path==='/api/me') return json(res,200,{user});
    if (m==='POST' && path==='/api/orders') {
      const input=await bodyJson(req);
      const key=string(req.headers['idempotency-key'],'Idempotency-Key',100);
      assert(Array.isArray(input.items) && input.items.length>0 && input.items.length<=30,400,'Cart must contain 1–30 products');
      const items=new Map();
      for(const item of input.items) {
        assert(typeof item.product_id==='string' && Number.isInteger(item.quantity) && item.quantity>=1 && item.quantity<=99,400,'Invalid cart item');
        items.set(item.product_id,(items.get(item.product_id)||0)+item.quantity);
      }
      assert([...items.values()].every(q=>q<=99),400,'Quantity limit exceeded');
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous=db.prepare('SELECT id FROM orders WHERE user_id=? AND idempotency_key=?').get(user.id,key);
        if(previous) { const saved=presentOrder(previous.id);db.exec('COMMIT');return json(res,200,{order:saved,replayed:true}); }
        let total=0;const chosen=[];
        for(const [pid,quantity] of items) {
          const product=db.prepare('SELECT * FROM products WHERE id=? AND active=1').get(pid);
          assert(product,404,'Product unavailable'); assert(product.stock>=quantity,409,`Insufficient stock for ${product.name}`);
          total+=product.price_cents*quantity;
          chosen.push({product,quantity});
        }
        assert(total<=100_000_000,400,'Cart total exceeds limit');
        const oid=id();db.prepare(`INSERT INTO orders VALUES (?,?,?,?,?,?)`).run(oid,user.id,'PLACED',total,key,now());
        for(const {product,quantity} of chosen) {
          const r=db.prepare('UPDATE products SET stock=stock-? WHERE id=? AND stock>=?').run(quantity,product.id,quantity);
          assert(r.changes===1,409,'Inventory changed, retry checkout');
          db.prepare('INSERT INTO order_items VALUES (?,?,?,?)').run(oid,product.id,quantity,product.price_cents);
        }
        db.exec('COMMIT');return json(res,201,{order:presentOrder(oid),replayed:false});
      } catch(e) {db.exec('ROLLBACK');throw e;}
    }
    if(m==='GET' && path==='/api/orders') {
      const rows=user.role==='ADMIN' ? db.prepare('SELECT id FROM orders ORDER BY created_at DESC LIMIT 200').all() : db.prepare('SELECT id FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(user.id);
      return json(res,200,{orders:rows.map(x=>presentOrder(x.id))});
    }
    let match;
    if(m==='POST' && path==='/api/admin/products') {
      adminOnly(user); const input=await bodyJson(req);
      const product={id:id(),name:string(input.name,'Product name',120),category:string(input.category,'Category',60),description:String(input.description || '').slice(0,1200),price_cents:input.price_cents,stock:input.stock};
      assert(Number.isInteger(product.price_cents)&&product.price_cents>0 && Number.isInteger(product.stock)&&product.stock>=0,400,'Invalid price or stock');
      db.prepare('INSERT INTO products VALUES (?,?,?,?,?,?,?,?)').run(...Object.values(product),1,now());
      return json(res,201,{product});
    }
    if((match=/^\/api\/admin\/products\/([^/]+)$/.exec(path))&&m==='PATCH') {
      adminOnly(user);const old=db.prepare('SELECT * FROM products WHERE id=?').get(match[1]);assert(old,404,'Product not found');
      const input=await bodyJson(req);const product={name:input.name===undefined?old.name:string(input.name,'Product name',120),category:input.category===undefined?old.category:string(input.category,'Category',60),description:input.description===undefined?old.description:String(input.description).slice(0,1200),price_cents:input.price_cents??old.price_cents,stock:input.stock??old.stock,active:input.active===undefined?old.active:Number(Boolean(input.active))};
      assert(Number.isInteger(product.price_cents)&&product.price_cents>0&&Number.isInteger(product.stock)&&product.stock>=0,400,'Invalid price or stock');
      db.prepare('UPDATE products SET name=?,category=?,description=?,price_cents=?,stock=?,active=? WHERE id=?').run(...Object.values(product),old.id);
      return json(res,200,{product:{id:old.id,...product}});
    }
    if((match=/^\/api\/admin\/orders\/([^/]+)\/status$/.exec(path))&&m==='PATCH') {
      adminOnly(user);const input=await bodyJson(req);
      assert(['FULFILLED','CANCELLED'].includes(input.status),400,'Invalid order status');
      db.exec('BEGIN IMMEDIATE');
      try {
        const current=db.prepare('SELECT * FROM orders WHERE id=?').get(match[1]);assert(current,404,'Order not found');
        assert(current.status==='PLACED',409,'Only placed orders can change status');
        db.prepare('UPDATE orders SET status=? WHERE id=?').run(input.status,current.id);
        if(input.status==='CANCELLED') for(const item of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(current.id)) db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(item.quantity,item.product_id);
        db.exec('COMMIT');return json(res,200,{order:presentOrder(current.id)});
      } catch(e){db.exec('ROLLBACK');throw e;}
    }
    if(m==='GET' && path==='/api/admin/analytics') {
      adminOnly(user);
      const summary=db.prepare(`SELECT COUNT(*) AS total_orders, COALESCE(SUM(CASE WHEN status!='CANCELLED' THEN total_cents ELSE 0 END),0) AS revenue_cents, SUM(CASE WHEN status='PLACED' THEN 1 ELSE 0 END) AS pending_orders FROM orders`).get();
      const topProducts=db.prepare(`SELECT p.name,SUM(i.quantity) AS units_sold,SUM(i.quantity*i.unit_price_cents) AS revenue_cents FROM order_items i JOIN orders o ON o.id=i.order_id JOIN products p ON p.id=i.product_id WHERE o.status!='CANCELLED' GROUP BY i.product_id ORDER BY revenue_cents DESC LIMIT 5`).all();
      const recent=db.prepare(`SELECT substr(created_at,1,10) AS day,COUNT(*) AS orders,COALESCE(SUM(CASE WHEN status!='CANCELLED' THEN total_cents ELSE 0 END),0) AS revenue_cents FROM orders GROUP BY day ORDER BY day DESC LIMIT 14`).all();
      return json(res,200,{summary,topProducts,recent});
    }
    throw new ApiError(404,'Route not found');
  }
  const server=createHttpServer(apiServer(handler));return {server,db,close(){server.close();db.close();}};
}
if(process.argv[1]?.endsWith('/app.js')) {const {server}=createApp();server.listen(Number(process.env.PORT||4002),()=>console.log('CommerceIQ API on http://localhost:'+(process.env.PORT||4002)));}
