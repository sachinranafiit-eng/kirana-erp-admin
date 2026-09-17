const router=require('express').Router();
const wrap=require('../utils/asyncHandler');
const E=require('../utils/ApiError');
const {authenticate}=require('../middleware/auth.middleware');
const {requirePermission:permit,requirePin}=require('../middleware/rbac.middleware');
const db=require('../config/db');
const H=require('../services/erp.helpers');
const T=require('../services/trading.service');
const R=require('../services/reports.service');
const ok=(res,data)=>res.json({success:true,data});
router.use(authenticate);
router.get('/context',wrap(async(req,res)=>{
 const stores=(await db.query(req.user.role_name==='super_admin'?'SELECT * FROM stores WHERE is_active':'SELECT * FROM stores WHERE id=$1',req.user.role_name==='super_admin'?[]:[req.user.store_id])).rows;
 const categories=(await db.query('SELECT * FROM categories ORDER BY name')).rows,units=(await db.query('SELECT * FROM units ORDER BY id')).rows,brands=(await db.query('SELECT * FROM brands ORDER BY name')).rows;
 ok(res,{stores,categories,units,brands,today:H.today()});
}));
router.get('/dashboard',wrap(async(req,res)=>ok(res,await R.dashboard(req.query,req.user))));
router.get('/catalog',permit('products.view'),wrap(async(req,res)=>{
 const st=H.scope(req.user,req.query.storeId); const search='%'+(req.query.search||'')+'%';
 const rows=(await db.query(`SELECT p.*,c.name category_name,u.short_code unit_code,COALESCE((SELECT sum(s.current_qty) FROM stock s LEFT JOIN product_batches b ON b.id=s.batch_id WHERE s.product_id=p.id AND s.store_id=$1 AND (b.expiry_date IS NULL OR b.expiry_date >= $3::date)),0) total_stock,(SELECT array_agg(barcode) FROM product_barcodes WHERE product_id=p.id) barcodes FROM products p LEFT JOIN categories c ON c.id=p.category_id JOIN units u ON u.id=p.unit_id WHERE p.is_active AND (p.name ILIKE $2 OR p.local_name ILIKE $2 OR p.sku ILIKE $2 OR EXISTS(SELECT 1 FROM product_barcodes pb WHERE pb.product_id=p.id AND pb.barcode ILIKE $2)) ORDER BY p.name LIMIT 500`,[st,search,H.today()])).rows;
 if(!H.can(req.user,'pricing.view_cost_price'))rows.forEach(p=>delete p.cost_price);ok(res,rows);
}));
router.post('/sales/quote',permit('sales.add'),wrap(async(req,res)=>{const r=await db.withTransaction(c=>T.prepareSale(c,req.body,req.user));ok(res,r.total);}));
router.post('/sales',permit('sales.add'),wrap(async(req,res)=>ok(res,await T.createSale(req.body,req.user))));
router.post('/purchases',permit('purchases.add'),wrap(async(req,res)=>ok(res,await T.createPurchase(req.body,req.user))));
for(const kind of ['sale','purchase']){
 const plural=kind==='sale'?'sales':'purchases';
 router.get('/'+plural,permit(plural+'.view'),wrap(async(req,res)=>ok(res,(await R.report(plural,req.query,req.user)).rows)));
 router.get('/'+plural+'/:id',permit(plural+'.view'),wrap(async(req,res)=>ok(res,await T.detail(kind,req.params.id,req.user))));
 router.post('/'+plural+'/:id/return',permit(plural+'.return'),requirePin,wrap(async(req,res)=>ok(res,await T.returnItems(kind,req.params.id,req.body,req.user))));
}
router.get('/held-bills',permit('sales.add'),wrap(async(req,res)=>ok(res,(await db.query('SELECT * FROM held_bills WHERE store_id=$1 ORDER BY id DESC',[H.scope(req.user,req.query.storeId)])).rows)));
router.post('/held-bills',permit('sales.add'),wrap(async(req,res)=>ok(res,await H.insert(db,'held_bills',{store_id:H.scope(req.user,req.body.storeId),user_id:req.user.id,name:req.body.name||'Held bill',payload:JSON.stringify(req.body.payload||{})}))));
router.delete('/held-bills/:id',permit('sales.add'),wrap(async(req,res)=>{await db.query('DELETE FROM held_bills WHERE id=$1 AND store_id=$2',[req.params.id,H.scope(req.user,req.query.storeId)]);ok(res,true);}));
router.get('/stock',permit('inventory.view'),wrap(async(req,res)=>ok(res,(await R.report('stock',req.query,req.user)).rows)));
router.get('/batches',permit('inventory.view'),wrap(async(req,res)=>{const rows=(await db.query('SELECT b.*,p.name,s.current_qty,s.store_id FROM product_batches b JOIN products p ON p.id=b.product_id JOIN stock s ON s.batch_id=b.id WHERE s.store_id=$1 ORDER BY b.expiry_date NULLS LAST,b.id',[H.scope(req.user,req.query.storeId)])).rows;if(!H.can(req.user,'pricing.view_cost_price'))rows.forEach(r=>delete r.cost_price);ok(res,rows);}));
router.get('/movements',permit('inventory.view'),wrap(async(req,res)=>{const rows=(await db.query('SELECT m.*,p.name,b.batch_number FROM stock_movements m JOIN products p ON p.id=m.product_id LEFT JOIN product_batches b ON b.id=m.batch_id WHERE m.store_id=$1 ORDER BY m.id DESC LIMIT 500',[H.scope(req.user,req.query.storeId)])).rows;if(!H.can(req.user,'pricing.view_cost_price'))rows.forEach(r=>delete r.cost_rate);ok(res,rows);}));
router.post('/adjustments',permit('inventory.adjust'),requirePin,wrap(async(req,res)=>{
 const b=req.body;const qty=H.number(Math.abs(b.quantity),'Quantity',{min:.001})*(Number(b.quantity)<0?-1:1);const reason=H.required(b.reason,'Adjustment reason');
 await db.withTransaction(async c=>{const p=(await c.query('SELECT * FROM products WHERE id=$1',[b.productId])).rows[0];if(!p)throw E.notFound('Product not found');if(b.batchId&&!(await c.query('SELECT 1 FROM product_batches WHERE id=$1 AND product_id=$2',[b.batchId,p.id])).rows.length)throw E.badRequest('Batch belongs to another product');if((p.track_batches||p.track_expiry)&&!b.batchId)throw E.badRequest('Select a batch for this item');await H.movement(c,{storeId:H.scope(req.user,b.storeId),productId:p.id,batchId:b.batchId||null,qty,type:['damage','expired'].includes(b.type)?b.type:'adjustment',rate:p.cost_price,referenceType:'adjustment',referenceId:require('crypto').randomUUID(),userId:req.user.id,notes:reason});await H.audit(c,req.user,'inventory.adjust','product',p.id,{qty,reason});});ok(res,true);
}));
router.post('/transfers',permit('inventory.transfer'),wrap(async(req,res)=>{
 const b=req.body;const from=H.scope(req.user,b.storeId),to=Number(b.toStoreId);if(from===to)throw E.badRequest('Select a different destination store');
 await db.withTransaction(async c=>{const dest=await H.store(c,to);const qty=H.number(b.quantity,'Quantity',{min:.001});const p=(await c.query('SELECT * FROM products WHERE id=$1 FOR UPDATE',[b.productId])).rows[0];if(!p)throw E.notFound('Product not found');const parts=await H.allocate(c,from,p.id,qty,H.today(),b.batchId);const ref=require('crypto').randomUUID();for(const a of parts){for(const [storeId,sign,type] of [[from,-1,'transfer_out'],[dest.id,1,'transfer_in']])await H.movement(c,{storeId,productId:p.id,batchId:a.batch_id,qty:sign*a.quantity,type,rate:p.cost_price,referenceType:'transfer',referenceId:ref,userId:req.user.id,notes:b.notes});}await H.audit(c,req.user,'inventory.transfer','product',p.id,{from,to,qty});});ok(res,true);
}));
router.get('/purchase-orders',permit('purchases.view'),wrap(async(req,res)=>ok(res,(await db.query('SELECT o.*,s.company_name supplier FROM purchase_orders o JOIN suppliers s ON s.id=o.supplier_id WHERE o.store_id=$1 ORDER BY o.id DESC',[H.scope(req.user,req.query.storeId)])).rows)));
router.post('/purchase-orders',permit('purchases.add'),wrap(async(req,res)=>ok(res,await db.withTransaction(async c=>{const b=req.body;const st=H.scope(req.user,b.storeId);if(!b.supplierId||!Array.isArray(b.items)||!b.items.length)throw E.badRequest('Supplier and items required');for(const i of b.items)H.number(i.quantity,'Quantity',{min:.001});const fy=await H.financialYear(c,H.today());const po=await H.invoiceNumber(c,st,fy.code,'po','PO');const row=await H.insert(c,'purchase_orders',{store_id:st,supplier_id:b.supplierId,po_number:po,status:'draft',items:JSON.stringify(b.items),expected_date:b.expectedDate?H.date(b.expectedDate):null,notes:b.notes||null,created_by:req.user.id});await H.audit(c,req.user,'purchase_order.create','purchase_order',row.id);return row;}))));
router.post('/purchase-orders/:id/approve',permit('purchases.approve'),wrap(async(req,res)=>{const row=(await db.query("UPDATE purchase_orders SET status='sent' WHERE id=$1 AND store_id=$2 AND status='draft' RETURNING *",[req.params.id,H.scope(req.user,req.body.storeId)])).rows[0];if(!row)throw E.badRequest('Only a draft order can be approved');ok(res,row);}));
router.get('/expenses',permit('expenses.manage'),wrap(async(req,res)=>ok(res,(await R.report('expenses',req.query,req.user)).rows)));
router.post('/expenses',permit('expenses.manage'),wrap(async(req,res)=>{
 const b=req.body;const row=await db.withTransaction(async c=>{const r=await H.insert(c,'expenses',{store_id:H.scope(req.user,b.storeId),expense_date:H.date(b.date||H.today()),category:H.required(b.category,'Category'),description:b.description||null,amount:H.number(b.amount,'Amount',{min:.01,scale:2}),payment_mode:b.paymentMode||'cash',vendor:b.vendor||null,reference:b.reference||null,created_by:req.user.id});await H.audit(c,req.user,'expense.create','expense',r.id);return r;});ok(res,row);
}));
router.get('/ledger/:type/:id',permit('payments.manage'),wrap(async(req,res)=>{
 const {type,id}=req.params;if(!['customer','supplier'].includes(type))throw E.badRequest('Invalid party');const sale=type==='customer';
 const data=await db.withTransaction(async c=>{const party=(await c.query(`SELECT * FROM ${sale?'customers':'suppliers'} WHERE id=$1`,[id])).rows[0];if(!party)throw E.notFound('Party not found');const invoices=(await c.query(`SELECT id,invoice_number,total_amount,created_at FROM ${sale?'sales':'purchases'} WHERE ${sale?'customer_id':'supplier_id'}=$1 ${sale?"AND status='completed'":''} ORDER BY created_at`,[id])).rows;const payments=(await c.query('SELECT * FROM payments WHERE party_type=$1 AND party_id=$2 ORDER BY id',[type,id])).rows;const notes=(await c.query(`SELECT * FROM ${sale?'credit_notes':'debit_notes'} WHERE ${sale?'customer_id':'supplier_id'}=$1`,[id])).rows;return {party,invoices,payments,notes,balance:await H.balance(c,type,id)};});ok(res,data);
}));
router.post('/payments',permit('payments.manage'),wrap(async(req,res)=>{
 const b=req.body; if(!['customer','supplier'].includes(b.partyType)||!T.modes.includes(b.mode))throw E.badRequest('Choose a party and payment mode');const key=H.required(b.idempotencyKey,'Request ID');
 ok(res,await db.withTransaction(async c=>{const prev=(await c.query('SELECT * FROM payments WHERE idempotency_key=$1',[key])).rows[0];if(prev){H.scope(req.user,prev.store_id);return prev;}
 const partyTable=b.partyType==='customer'?'customers':'suppliers';await c.query(`SELECT id FROM ${partyTable} WHERE id=$1 FOR UPDATE`,[b.partyId]);const balance=await H.balance(c,b.partyType,b.partyId);const amount=H.number(b.amount,'Amount',{min:.01,scale:2});if(amount>balance)throw E.badRequest('Payment exceeds outstanding balance');
 const row=await H.insert(c,'payments',{store_id:H.scope(req.user,b.storeId),party_type:b.partyType,party_id:b.partyId,reference_type:'advance',amount,mode:b.mode,payment_date:H.date(b.date||H.today()),reference:b.reference||null,idempotency_key:key,created_by:req.user.id});await H.audit(c,req.user,'payment.create','payment',row.id,{amount});return row;}));
}));
router.get('/reports/:type',permit('reports.view'),wrap(async(req,res)=>{const data=await R.report(req.params.type,req.query,req.user);if(req.query.export==='csv'){H.permit(req.user,'reports.export');const keys=Object.keys(data.rows[0]||{});const escape=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replace(/"/g,'""')+'"';res.type('text/csv').attachment(data.type+'.csv').send('\uFEFF'+[keys.map(escape).join(','),...data.rows.map(r=>keys.map(k=>escape(r[k])).join(','))].join('\r\n'));}else ok(res,data);}));
router.get('/settings',permit('settings.manage'),wrap(async(req,res)=>ok(res,{stores:(await db.query('SELECT * FROM stores ORDER BY id')).rows,financialYears:(await db.query('SELECT * FROM financial_years ORDER BY start_date DESC')).rows,settings:(await db.query('SELECT * FROM settings ORDER BY key')).rows,integrationStatus:{sms:!!(process.env.MSG91_AUTH_KEY&&process.env.MSG91_SENDER_ID),whatsapp:!!(process.env.WHATSAPP_ACCESS_TOKEN&&process.env.WHATSAPP_PHONE_NUMBER_ID)}})));
router.put('/stores/:id',permit('settings.manage'),wrap(async(req,res)=>{
 const b=req.body;const id=H.scope(req.user,req.params.id);const state=String(b.stateCode||'');if(!/^\d{2}$/.test(state))throw E.badRequest('State code must have two digits');const gstin=H.gstin(b.gstin,state);if(!['regular','composition','unregistered'].includes(b.registrationType))throw E.badRequest('Choose GST registration type');if(b.registrationType!=='unregistered'&&!gstin)throw E.badRequest('GSTIN required');if(!/^[A-Za-z0-9]{1,5}$/.test(b.invoicePrefix||''))throw E.badRequest('Invoice prefix must be 1–5 letters or digits');
 const row=(await db.query('UPDATE stores SET name=$1,address=$2,state=$3,state_code=$4,gstin=$5,registration_type=$6,phone=$7,email=$8,invoice_prefix=$9,receipt_footer=$10 WHERE id=$11 RETURNING *',[H.required(b.name,'Store name'),b.address||'',b.state||'',state,gstin,b.registrationType,b.phone||'',b.email||null,b.invoicePrefix,b.receiptFooter||'',id])).rows[0];await H.audit(db,req.user,'settings.store','store',id);ok(res,row);
}));
router.post('/stores',permit('settings.manage'),wrap(async(req,res)=>{if(req.user.role_name!=='super_admin')throw E.forbidden('Only the owner can create stores');const b=req.body;ok(res,await H.insert(db,'stores',{name:H.required(b.name,'Name'),type:b.type||'shop',address:b.address||'',state:b.state||'',state_code:b.stateCode||'05'}));}));
router.get('/activity',permit('users.manage'),wrap(async(req,res)=>ok(res,(await db.query('SELECT l.*,u.full_name FROM user_activity_logs l LEFT JOIN users u ON u.id=l.user_id ORDER BY l.id DESC LIMIT 500')).rows)));
module.exports=router;
