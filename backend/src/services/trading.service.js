const {withTransaction,query}=require('../config/db');
const H=require('./erp.helpers');
const E=require('../utils/ApiError');
const {D,money}=H;
const modes=['cash','upi','card','bank','wallet'];
function requestKey(b){const k=H.required(b.idempotencyKey,'Request ID');if(k.length>100)throw E.badRequest('Invalid request ID');return k;}
async function gstRow(c,type,ref,on,st,party,invoice,line,sign=1){await H.insert(c,'gst_transactions',{transaction_type:type,reference_id:ref,transaction_date:on,store_id:st.id,party_gstin:party?.gstin||null,place_of_supply:line.place_of_supply||st.state_code,invoice_number:invoice,hsn_code:line.snapshot?.hsn_code||'',gst_rate:line.gst_rate,...Object.fromEntries(['taxable_amount','cgst_amount','sgst_amount','igst_amount','cess_amount'].map(k=>[k,money(new D(line[k]||0).mul(sign))]))});}
function checkLines(b){if(!Array.isArray(b.items)||!b.items.length||b.items.length>500)throw E.badRequest('Add between 1 and 500 items');}
async function prepareSale(c,b,user){
 checkLines(b); const st=await H.store(c,H.scope(user,b.storeId));const on=H.date(b.date||H.today());
 const customer=b.customerId?(await c.query('SELECT * FROM customers WHERE id=$1 AND is_active=true FOR UPDATE',[b.customerId])).rows[0]:null;
 if(b.customerId&&!customer)throw E.badRequest('Customer unavailable');
 const pos=String(b.placeOfSupply||customer?.state_code||st.state_code);if(!/^\d{2}$/.test(pos))throw E.badRequest('Set the store state code before billing');
 if(st.registration_type==='regular'&&!st.gstin)throw E.badRequest('Complete GST details in Settings');
 const taxEnabled=st.registration_type==='regular';
 const ids=[...new Set(b.items.map(i=>Number(i.productId)))].sort((a,b)=>a-b);
 for(const id of ids)await c.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[id]);
 const lines=[]; const claimed=new Map();
 for(const input of b.items){
  const p=(await c.query('SELECT p.*,u.short_code AS unit_code FROM products p JOIN units u ON u.id=p.unit_id WHERE p.id=$1 AND p.is_active=true',[input.productId])).rows[0];if(!p)throw E.badRequest('Product unavailable');
  const qty=H.number(input.quantity,'Quantity',{min:.001});const rate=H.number(input.rate??p.sale_price,'Selling price',{scale:2});
  if(rate!==Number(p.sale_price))H.permit(user,'pricing.change_selling_price');
  const discount=H.number(input.discountPct||0,'Discount',{max:100,scale:2});if(discount>0)H.permit(user,'sales.discount');
  const effectiveGross=p.tax_inclusive||!taxEnabled?rate:money(new D(rate).mul(new D(1).plus(new D(p.gst_rate).plus(p.cess_rate).div(100))));
  if(effectiveGross>Number(p.mrp))throw E.badRequest(`${p.name}: selling price including tax exceeds MRP`);
  if(p.min_selling_price && new D(rate).mul(1-discount/100).lt(p.min_selling_price))throw E.badRequest(`${p.name}: below minimum selling price`);
  const key=String(p.id);const prior=claimed.get(key)||0;const all=await H.allocate(c,st.id,p.id,new D(qty).plus(prior).toNumber(),on,input.batchId);claimed.set(key,prior+qty);
  let skip=prior;for(const a of all){const used=Math.min(skip,a.quantity);skip-=used;const take=moneyQty(a.quantity-used);if(!take)continue;
   const tax=H.lineTax({qty:take,rate,discount,gst:taxEnabled?p.gst_rate:0,cess:taxEnabled?p.cess_rate:0,inclusive:p.tax_inclusive,interstate:pos!==st.state_code});
   lines.push({...tax,product_id:p.id,batch_id:a.batch_id,cost_price_snapshot:p.cost_price,place_of_supply:pos,snapshot:{name:p.name,local_name:p.local_name,sku:p.sku,hsn_code:p.hsn_code,unit:p.unit_code,mrp:p.mrp,batch_number:a.batch_number,expiry_date:a.expiry_date,tax_inclusive:p.tax_inclusive}});
  }
 }
 const total=H.totals(lines);const round=b.roundOff?money(new D(total.total_amount).round().minus(total.total_amount)):0;total.round_off=round;total.total_amount=money(new D(total.total_amount).plus(round));
 return {st,on,customer,pos,lines,total,taxEnabled};
}
const moneyQty=v=>new D(v).toDecimalPlaces(3).toNumber();
async function paymentRows(c,b,user,st,partyType,partyId,refType,refId,total,on){
 const payments=b.payments||[];if(!Array.isArray(payments)||payments.length>10)throw E.badRequest('Invalid payment split');
 const sum=money(payments.reduce((n,p)=>n.plus(H.number(p.amount,'Payment',{min:.01,scale:2})),new D(0)));
 if(sum>total)throw E.badRequest('Recorded payments exceed the invoice total; record cash change separately');
 if(sum<total && partyType==='customer'&&!partyId)throw E.badRequest('Select a customer for credit billing');
 for(const p of payments){if(!modes.includes(p.mode))throw E.badRequest('Invalid payment method');await H.insert(c,'payments',{party_type:partyType,party_id:partyId||0,reference_type:refType,reference_id:refId,amount:p.amount,mode:p.mode,store_id:st.id,payment_date:on,reference:p.reference||null,created_by:user.id});}
 return sum;
}
async function createSale(b,user){
 H.permit(user,'sales.add');const key=requestKey(b);
 return withTransaction(async c=>{
 const prior=(await c.query('SELECT * FROM sales WHERE idempotency_key=$1',[key])).rows[0];if(prior){H.scope(user,prior.store_id);return prior;}
 const {st,on,customer,pos,lines,total,taxEnabled}=await prepareSale(c,b,user);
 const fy=await H.financialYear(c,on);const inv=await H.invoiceNumber(c,st.id,fy.code,'sale',st.invoice_prefix);
 const invoice=await H.insert(c,'sales',{store_id:st.id,financial_year_id:fy.id,customer_id:customer?.id||null,invoice_number:inv,invoice_type:taxEnabled?'gst':'non_gst',business_date:on,place_of_supply:pos,customer_snapshot:customer?JSON.stringify({name:customer.name,address:customer.address,gstin:customer.gstin,mobile:customer.mobile,state_code:customer.state_code}):null,store_snapshot:JSON.stringify(st),subtotal:total.taxable_amount,discount_amount:total.discount_amount,cgst_amount:total.cgst_amount,sgst_amount:total.sgst_amount,igst_amount:total.igst_amount,cess_amount:total.cess_amount,round_off:total.round_off,total_amount:total.total_amount,payment_mode:b.payments?.length>1?'split':b.payments?.[0]?.mode||'credit',cashier_id:user.id,notes:b.notes||null,idempotency_key:key});
 for(const l of lines){const {place_of_supply,discount_amount,cess_rate,...item}=l;await H.insert(c,'sale_items',{...item,rate:l.rate,sale_id:invoice.id,snapshot:JSON.stringify(l.snapshot)});await H.movement(c,{storeId:st.id,productId:l.product_id,batchId:l.batch_id,qty:-l.quantity,type:'sale',rate:l.cost_price_snapshot,referenceType:'sale',referenceId:invoice.id,userId:user.id});await gstRow(c,'sale',invoice.id,on,st,customer,inv,l);}
 const paid=await paymentRows(c,b,user,st,'customer',customer?.id,'sale',invoice.id,total.total_amount,on);
 if(customer&&paid<total.total_amount){const outstanding=await H.balance(c,'customer',customer.id);if(new D(outstanding).gt(customer.credit_limit))throw E.badRequest(`Credit limit exceeded. Available limit: ₹${customer.credit_limit}`);}
 if(b.heldBillId)await c.query('DELETE FROM held_bills WHERE id=$1 AND store_id=$2',[b.heldBillId,st.id]);
 await H.audit(c,user,'sale.create','sale',invoice.id,{total:invoice.total_amount});return {...invoice,paid_amount:paid};
 });
}
async function createPurchase(b,user,existingClient){
 H.permit(user,'purchases.add');const key=requestKey(b);checkLines(b);
 const run=async c=>{
 const prior=(await c.query('SELECT * FROM purchases WHERE idempotency_key=$1',[key])).rows[0];if(prior){H.scope(user,prior.store_id);return prior;}
 const st=await H.store(c,H.scope(user,b.storeId));const on=H.date(b.date||H.today());
 const supplier=(await c.query('SELECT * FROM suppliers WHERE id=$1 AND is_active=true FOR UPDATE',[b.supplierId])).rows[0];if(!supplier)throw E.badRequest('Select an active supplier');
 const supplierInv=H.required(b.supplierInvoiceNo,'Supplier invoice number');const invDate=H.date(b.supplierInvoiceDate||on,'Supplier invoice date');
 if(b.reverseCharge)throw E.badRequest('Reverse-charge invoices need accountant handling outside this standard goods workflow');
 if(supplier.registration_type!=='unregistered'&&!supplier.gstin)throw E.badRequest('Supplier GSTIN is required');
 const pos=String(b.placeOfSupply||st.state_code);if(!/^\d{2}$/.test(pos))throw E.badRequest('Place of supply state code is required');
 const lines=[];const receivedQty=new Map();for(const id of [...new Set(b.items.map(i=>Number(i.productId)))].sort((a,b)=>a-b))await c.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[id]);
 for(const input of b.items){
  const p=(await c.query('SELECT p.*,u.short_code unit_code,(SELECT barcode FROM product_barcodes WHERE product_id=p.id LIMIT 1) barcode FROM products p JOIN units u ON u.id=p.unit_id WHERE p.id=$1 AND p.is_active=true',[input.productId])).rows[0];if(!p)throw E.badRequest('Select an active product');
  const gst=H.number(input.gstRate??p.gst_rate,'GST rate',{max:100,scale:2});const cess=H.number(input.cessRate??p.cess_rate,'Cess rate',{max:100,scale:2});
  if(supplier.registration_type!=='regular' && (gst>0||cess>0))throw E.badRequest('Composition and unregistered suppliers cannot charge GST. Set line GST to zero.');
  if(supplier.registration_type==='regular'&&!supplier.state_code)throw E.badRequest('Set the supplier state code');
  const tax=H.lineTax({qty:input.quantity,rate:input.rate,discount:input.discountPct||0,gst,cess,inclusive:!!input.taxInclusive,interstate:supplier.state_code!==pos});
  const free=H.number(input.freeQuantity||0,'Free quantity');const mrp=H.number(input.mrp??p.mrp,'MRP',{scale:2});const price=H.number(input.salePrice??p.sale_price,'Selling price',{scale:2});if(price>mrp)throw E.badRequest('Selling price exceeds MRP');
  if((mrp!==Number(p.mrp)||price!==Number(p.sale_price)))H.permit(user,'pricing.change_selling_price');
  let batch=null;if(input.batchNumber||input.expiryDate||input.mfgDate||p.track_batches||p.track_expiry){
   if(p.track_batches&&!input.batchNumber)throw E.badRequest(`${p.name}: batch number required`);
   if(p.track_expiry&&!input.expiryDate)throw E.badRequest(`${p.name}: expiry date required`);
   const expiry=input.expiryDate?H.date(input.expiryDate,'Expiry date'):null;const mfg=input.mfgDate?H.date(input.mfgDate,'Manufacturing date'):null;
   if(expiry&&expiry<on)throw E.badRequest('Cannot receive expired goods');if(mfg&&expiry&&mfg>expiry)throw E.badRequest('Manufacturing date is after expiry');
   batch=await H.insert(c,'product_batches',{product_id:p.id,batch_number:input.batchNumber||null,mfg_date:mfg,expiry_date:expiry,cost_price:money(new D(tax.taxable_amount).div(new D(tax.quantity).plus(free))),mrp});
  }
  const physical=(await c.query('SELECT COALESCE(sum(current_qty),0) qty FROM stock WHERE product_id=$1',[p.id])).rows[0].qty;const before=new D(physical).plus(receivedQty.get(p.id)||0);receivedQty.set(p.id,new D(receivedQty.get(p.id)||0).plus(tax.quantity).plus(free).toNumber());
  const netQty=new D(tax.quantity).plus(free);const landed=b.reverseCharge||st.registration_type!=='regular'?tax.total_amount:tax.taxable_amount;
  const avg=money(new D(before).mul(p.cost_price).plus(landed).div(new D(before).plus(netQty)));
  await c.query('UPDATE products SET cost_price=$1,mrp=$2,sale_price=$3 WHERE id=$4',[avg,mrp,price,p.id]);
  lines.push({...tax,product_id:p.id,batch_id:batch?.id||null,free_quantity:free,place_of_supply:pos,snapshot:{name:p.name,local_name:p.local_name,sku:p.sku,barcode:p.barcode,hsn_code:input.hsnCode||p.hsn_code,unit:p.unit_code,mrp,sale_price:price,batch_number:batch?.batch_number,mfg_date:batch?.mfg_date,expiry_date:batch?.expiry_date,tax_inclusive:!!input.taxInclusive,cess_rate:cess}});
  // Stock receipt is posted below after the invoice obtains its reference.
 }
 const total=H.totals(lines);const fy=await H.financialYear(c,on);const inv=await H.invoiceNumber(c,st.id,fy.code,'purchase','PUR');
 const invoice=await H.insert(c,'purchases',{store_id:st.id,financial_year_id:fy.id,supplier_id:supplier.id,invoice_number:inv,supplier_invoice_no:supplierInv,supplier_invoice_date:invDate,purchase_date:on,place_of_supply:pos,supplier_snapshot:JSON.stringify(supplier),store_snapshot:JSON.stringify(st),po_number:b.poNumber||null,grn_number:b.grnNumber||null,due_date:b.dueDate?H.date(b.dueDate):null,reverse_charge:!!b.reverseCharge,notes:b.notes||null,source:b.source||'manual',...total,created_by:user.id,idempotency_key:key});
 for(const l of lines){await H.insert(c,'purchase_items',{purchase_id:invoice.id,product_id:l.product_id,batch_id:l.batch_id,quantity:l.quantity,free_quantity:l.free_quantity,purchase_rate:l.rate,discount_pct:l.discount_pct,gst_rate:l.gst_rate,taxable_amount:l.taxable_amount,total_amount:l.total_amount,cgst_amount:l.cgst_amount,sgst_amount:l.sgst_amount,igst_amount:l.igst_amount,cess_amount:l.cess_amount,snapshot:JSON.stringify(l.snapshot)});await H.movement(c,{storeId:st.id,productId:l.product_id,batchId:l.batch_id,qty:moneyQty(l.quantity+l.free_quantity),type:'purchase',rate:money(new D(l.taxable_amount).div(l.quantity+l.free_quantity)),referenceType:'purchase',referenceId:invoice.id,userId:user.id});await gstRow(c,'purchase',invoice.id,invDate,st,supplier,inv,l);}
 const paid=await paymentRows(c,b,user,st,'supplier',supplier.id,'purchase',invoice.id,total.total_amount,on);
 const status=paid===total.total_amount?'paid':paid>0?'partial':'unpaid';await c.query('UPDATE purchases SET payment_status=$1 WHERE id=$2',[status,invoice.id]);
 if(b.poNumber)await c.query("UPDATE purchase_orders SET status='received' WHERE po_number=$1 AND store_id=$2 AND supplier_id=$3",[b.poNumber,st.id,supplier.id]);
 await H.audit(c,user,'purchase.create','purchase',invoice.id,{total:total.total_amount});return {...invoice,payment_status:status};
 };return existingClient?run(existingClient):withTransaction(run);
}
async function detail(kind,id,user){
 const sale=kind==='sale';const table=sale?'sales':'purchases';const itemTable=sale?'sale_items':'purchase_items';const fk=sale?'sale_id':'purchase_id';
 const doc=(await query(`SELECT * FROM ${table} WHERE id=$1`,[id])).rows[0];if(!doc)throw E.notFound('Invoice not found');H.scope(user,doc.store_id);
 const items=(await query(`SELECT i.*,COALESCE((SELECT sum(r.quantity) FROM ${sale?'sales_returns':'purchase_returns'} r WHERE r.${sale?'sale_item_id':'purchase_item_id'}=i.id),0) returned_qty FROM ${itemTable} i WHERE ${fk}=$1 ORDER BY id`,[id])).rows;
 if(sale&&!H.can(user,'pricing.view_cost_price'))items.forEach(i=>delete i.cost_price_snapshot);
 const payments=(await query('SELECT * FROM payments WHERE reference_type=$1 AND reference_id=$2 ORDER BY id',[kind,id])).rows;
 return {...doc,items,payments,paid_amount:money(payments.reduce((s,p)=>s.plus(p.amount),new D(0)))};
}
async function returnItems(kind,id,b,user){
 const sale=kind==='sale';H.permit(user,sale?'sales.return':'purchases.return');const key=requestKey(b);checkLines(b);
 return withTransaction(async c=>{
 const prior=(await c.query('SELECT result FROM return_requests WHERE request_key=$1',[key])).rows[0];if(prior)return prior.result;
 const doc=(await c.query(`SELECT * FROM ${sale?'sales':'purchases'} WHERE id=$1 FOR UPDATE`,[id])).rows[0];if(!doc)throw E.notFound('Invoice not found');H.scope(user,doc.store_id);
 if(sale&&doc.status!=='completed')throw E.badRequest('This invoice cannot be returned');
 const st=doc.store_snapshot||await H.store(c,doc.store_id);const reason=H.required(b.reason,'Return reason');let total=new D(0);const returns=[];
 for(const input of b.items){
 const fk=sale?'sale_id':'purchase_id',itemFk=sale?'sale_item_id':'purchase_item_id',table=sale?'sales_returns':'purchase_returns';
 const l=(await c.query(`SELECT * FROM ${sale?'sale_items':'purchase_items'} WHERE id=$1 AND ${fk}=$2 FOR UPDATE`,[input.itemId,id])).rows[0];if(!l)throw E.badRequest('Invoice item not found');
 const qty=H.number(input.quantity,'Return quantity',{min:.001});const returned=(await c.query(`SELECT COALESCE(sum(quantity),0) qty FROM ${table} WHERE ${itemFk}=$1`,[l.id])).rows[0].qty;
 const originalQty=new D(l.quantity).plus(sale?0:l.free_quantity);if(new D(returned).plus(qty).gt(originalQty))throw E.badRequest('Return exceeds the remaining original quantity');
 const fraction=new D(qty).div(originalQty);const remainingFull=new D(returned).plus(qty).eq(originalQty);const neg={...l};
 for(const k of ['taxable_amount','cgst_amount','sgst_amount','igst_amount','cess_amount','total_amount'])neg[k]=money(new D(l[k]||0).mul(fraction));
 // Allocate component rounding to the final return as well as the refund total.
 if(remainingFull){const taxRows=(await c.query(`SELECT tax_components FROM ${table} WHERE ${itemFk}=$1`,[l.id])).rows;for(const k of ['cgst_amount','sgst_amount','igst_amount','cess_amount'])neg[k]=money(new D(l[k]||0).minus(taxRows.reduce((sum,r)=>sum.plus(r.tax_components?.[k]||0),new D(0))));}
 // Allocate the final paise to the last return so cumulative refunds never exceed the invoice line.
 if(remainingFull){const sums=(await c.query(`SELECT COALESCE(sum(amount),0) amount,COALESCE(sum(taxable_amount),0) taxable FROM ${table} WHERE ${itemFk}=$1`,[l.id])).rows[0];neg.total_amount=money(new D(l.total_amount).minus(sums.amount));neg.taxable_amount=money(new D(l.taxable_amount).minus(sums.taxable));}
 const refund=await H.insert(c,table,{[fk]:id,[itemFk]:l.id,product_id:l.product_id,quantity:qty,reason,amount:neg.total_amount,taxable_amount:neg.taxable_amount,gst_amount:money(new D(neg.total_amount).minus(neg.taxable_amount)),refund_mode:b.refundMode||'credit',tax_components:JSON.stringify(Object.fromEntries(['cgst_amount','sgst_amount','igst_amount','cess_amount'].map(k=>[k,neg[k]]))),created_by:user.id});
 await H.movement(c,{storeId:st.id,productId:l.product_id,batchId:l.batch_id,qty:sale?qty:-qty,type:sale?'sale_return':'purchase_return',rate:l.cost_price_snapshot||l.purchase_rate,referenceType:table,referenceId:refund.id,userId:user.id,notes:reason});
 await gstRow(c,sale?'sale_return':'purchase_return',refund.id,H.today(),st,sale?doc.customer_snapshot:doc.supplier_snapshot,doc.invoice_number,{...neg,place_of_supply:doc.place_of_supply},-1);total=total.plus(neg.total_amount);returns.push(refund);
 }
 const partyId=sale?doc.customer_id:doc.supplier_id;const amount=money(total);
 await H.insert(c,sale?'credit_notes':'debit_notes',{[sale?'customer_id':'supplier_id']:partyId,[sale?'sale_id':'purchase_id']:id,amount,reason});
 if(b.refundMode&&b.refundMode!=='credit'){
  if(!modes.includes(b.refundMode))throw E.badRequest('Invalid refund mode');
  const paid=(await c.query('SELECT COALESCE(sum(amount),0) amount FROM payments WHERE reference_type=$1 AND reference_id=$2',[kind,id])).rows[0].amount;
  if(new D(amount).gt(paid))throw E.badRequest('Cash/bank refund exceeds money collected or paid. Use credit adjustment.');
  await H.insert(c,'payments',{party_type:sale?'customer':'supplier',party_id:partyId||0,reference_type:kind,reference_id:id,amount:-amount,mode:b.refundMode,store_id:st.id,payment_date:H.today(),created_by:user.id,reference:reason});
 }
 if(sale&&!partyId&&(!b.refundMode||b.refundMode==='credit'))throw E.badRequest('Choose a refund method for a walk-in customer');
 await H.audit(c,user,kind+'.return',kind,id,{amount,reason});const result={amount,returns};await H.insert(c,'return_requests',{request_key:key,result:JSON.stringify(result)});return result;
 });
}
module.exports={createSale,createPurchase,prepareSale,detail,returnItems,gstRow,modes,paymentRows};
