const {query}=require('../config/db');
const H=require('./erp.helpers');
const E=require('../utils/ApiError');
async function report(type,b,user){
 const st=H.scope(user,b.storeId),from=H.date(b.from||H.today().slice(0,8)+'01'),to=H.date(b.to||H.today());if(from>to)throw E.badRequest('Start date is after end date');
 const p=[st,from,to];
 let rows=[];
 if(type==='sales')rows=(await query(`SELECT s.id,s.invoice_number,s.business_date,s.customer_snapshot->>'name' customer,s.subtotal taxable,s.cgst_amount,s.sgst_amount,s.igst_amount,s.cess_amount,s.total_amount,s.payment_mode,s.status,u.full_name cashier,(SELECT COALESCE(sum(amount),0) FROM payments WHERE reference_type='sale' AND reference_id=s.id) paid FROM sales s LEFT JOIN users u ON u.id=s.cashier_id WHERE s.store_id=$1 AND s.business_date BETWEEN $2 AND $3 ORDER BY s.id DESC`,p)).rows;
 else if(type==='purchases')rows=(await query(`SELECT p.id,p.invoice_number,p.supplier_invoice_no,p.supplier_invoice_date,p.purchase_date,p.supplier_snapshot->>'company_name' supplier,p.supplier_snapshot->>'gstin' gstin,p.taxable_amount,p.cgst_amount,p.sgst_amount,p.igst_amount,p.cess_amount,p.total_amount,p.payment_status,p.due_date FROM purchases p WHERE store_id=$1 AND purchase_date BETWEEN $2 AND $3 ORDER BY id DESC`,p)).rows;
 else if(type==='stock')rows=(await query(`SELECT p.id,p.sku,p.name,c.name category,u.short_code unit,p.mrp,p.sale_price,p.cost_price,p.reorder_level,COALESCE(sum(s.current_qty),0) quantity,COALESCE(sum(s.current_qty),0)*p.cost_price stock_value FROM products p LEFT JOIN stock s ON s.product_id=p.id AND s.store_id=$1 LEFT JOIN categories c ON c.id=p.category_id JOIN units u ON u.id=p.unit_id WHERE p.is_active GROUP BY p.id,c.name,u.short_code ORDER BY p.name`,[st])).rows;
 else if(type==='profit'){
 H.permit(user,'pricing.view_profit');
 const s=(await query(`SELECT COALESCE(sum(i.taxable_amount),0) revenue,COALESCE(sum(i.quantity*i.cost_price_snapshot),0) cogs FROM sale_items i JOIN sales s ON s.id=i.sale_id WHERE s.store_id=$1 AND s.status='completed' AND s.business_date BETWEEN $2 AND $3`,p)).rows[0];
 const r=(await query(`SELECT COALESCE(sum(r.taxable_amount),0) revenue,COALESCE(sum(r.quantity*i.cost_price_snapshot),0) cogs FROM sales_returns r JOIN sale_items i ON i.id=r.sale_item_id JOIN sales s ON s.id=r.sale_id WHERE s.store_id=$1 AND (r.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3`,p)).rows[0];
 const e=(await query('SELECT COALESCE(sum(amount),0) amount FROM expenses WHERE store_id=$1 AND expense_date BETWEEN $2 AND $3',p)).rows[0];
 const revenue=H.money(new H.D(s.revenue).minus(r.revenue)),cogs=H.money(new H.D(s.cogs).minus(r.cogs)),gross=H.money(new H.D(revenue).minus(cogs));
 rows=[{revenue_excluding_gst:revenue,cost_of_goods_sold:cogs,gross_profit:gross,expenses:Number(e.amount),net_profit:H.money(new H.D(gross).minus(e.amount))}];
 }else if(['gst','gstr1','gstr3b','hsn'].includes(type)){
 H.permit(user,'gst.manage');
 if(type==='hsn')rows=(await query(`SELECT hsn_code,gst_rate,transaction_type,sum(taxable_amount) taxable_amount,sum(cgst_amount) cgst,sum(sgst_amount) sgst,sum(igst_amount) igst,sum(cess_amount) cess FROM gst_transactions WHERE store_id=$1 AND transaction_date BETWEEN $2 AND $3 GROUP BY hsn_code,gst_rate,transaction_type ORDER BY hsn_code`,p)).rows;
 else if(type==='gstr3b') rows=(await query(`SELECT CASE WHEN transaction_type LIKE 'sale%' THEN 'Outward supplies (net of returns)' ELSE 'Purchase tax (review ITC eligibility)' END section,sum(taxable_amount) taxable_amount,sum(cgst_amount) cgst,sum(sgst_amount) sgst,sum(igst_amount) igst,sum(cess_amount) cess FROM gst_transactions WHERE store_id=$1 AND transaction_date BETWEEN $2 AND $3 GROUP BY CASE WHEN transaction_type LIKE 'sale%' THEN 'Outward supplies (net of returns)' ELSE 'Purchase tax (review ITC eligibility)' END`,p)).rows;
 else rows=(await query(`SELECT transaction_type,transaction_date,invoice_number,party_gstin,place_of_supply,hsn_code,gst_rate,taxable_amount,cgst_amount,sgst_amount,igst_amount,cess_amount FROM gst_transactions WHERE store_id=$1 AND transaction_date BETWEEN $2 AND $3 ${type==='gstr1'?"AND transaction_type LIKE 'sale%'":''} ORDER BY transaction_date,id`,p)).rows;
 }else if(type==='bestsellers')rows=(await query(`SELECT p.name,c.name category,sum(i.quantity) quantity,sum(i.taxable_amount) sales_excluding_gst FROM sale_items i JOIN sales s ON s.id=i.sale_id JOIN products p ON p.id=i.product_id LEFT JOIN categories c ON c.id=p.category_id WHERE s.store_id=$1 AND s.status='completed' AND s.business_date BETWEEN $2 AND $3 GROUP BY p.id,c.name ORDER BY quantity DESC`,p)).rows;
 else if(type==='payments')rows=(await query('SELECT payment_date,party_type,party_id,reference_type,reference_id,mode,amount,reference FROM payments WHERE store_id=$1 AND payment_date BETWEEN $2 AND $3 ORDER BY id DESC',p)).rows;
 else if(type==='expenses')rows=(await query('SELECT * FROM expenses WHERE store_id=$1 AND expense_date BETWEEN $2 AND $3 ORDER BY expense_date DESC',p)).rows;
 else if(type==='returns')rows=(await query(`SELECT 'sale' type,r.id,s.invoice_number,r.created_at,p.name,r.quantity,r.amount,r.reason,r.refund_mode FROM sales_returns r JOIN sales s ON s.id=r.sale_id JOIN products p ON p.id=r.product_id WHERE s.store_id=$1 AND (r.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3 UNION ALL SELECT 'purchase',r.id,s.invoice_number,r.created_at,p.name,r.quantity,r.amount,r.reason,r.refund_mode FROM purchase_returns r JOIN purchases s ON s.id=r.purchase_id JOIN products p ON p.id=r.product_id WHERE s.store_id=$1 AND (r.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2 AND $3`,p)).rows;
 else throw E.notFound('Report not found');
 if(!H.can(user,'pricing.view_cost_price'))rows.forEach(r=>{delete r.cost_price;delete r.stock_value;});
 return {type,from,to,storeId:st,rows,note:['gst','gstr1','gstr3b','hsn'].includes(type)?'Working data for accountant review. This is not a filed GST return or a portal-ready JSON submission.':''};
}
async function dashboard(b,user){
 const st=H.scope(user,b.storeId),on=H.today();
 const sales=H.can(user,'sales.view')?(await query("SELECT count(*) bills,COALESCE(sum(total_amount),0) total FROM sales WHERE store_id=$1 AND business_date=$2 AND status='completed'",[st,on])).rows[0]:null;
 const purchases=H.can(user,'purchases.view')?(await query('SELECT COALESCE(sum(total_amount),0) total FROM purchases WHERE store_id=$1 AND purchase_date=$2',[st,on])).rows[0]:null;
 const split=H.can(user,'sales.view')?(await query("SELECT mode,sum(amount) amount FROM payments WHERE store_id=$1 AND payment_date=$2 AND party_type='customer' GROUP BY mode",[st,on])).rows:[];
 const trend=H.can(user,'sales.view')?(await query("SELECT business_date date,sum(total_amount) total FROM sales WHERE store_id=$1 AND business_date >= $2::date-13 AND status='completed' GROUP BY business_date ORDER BY business_date",[st,on])).rows:[];
 const stock=(await report('stock',{storeId:st},user)).rows;
 const expiry=H.can(user,'inventory.view')?(await query("SELECT p.name,b.batch_number,b.expiry_date,s.current_qty FROM stock s JOIN product_batches b ON b.id=s.batch_id JOIN products p ON p.id=s.product_id WHERE s.store_id=$1 AND s.current_qty>0 AND b.expiry_date<=$2::date+30 ORDER BY b.expiry_date",[st,on])).rows:[];
 const profit=H.can(user,'pricing.view_profit')?(await report('profit',{storeId:st,from:on,to:on},user)).rows[0]:null;
 return {date:on,sales,purchases,split,trend,lowStock:stock.filter(p=>Number(p.quantity)<=Number(p.reorder_level)),expiry,profit,products:stock.length,stockValue:H.can(user,'pricing.view_cost_price')?H.money(stock.reduce((n,p)=>n.plus(p.stock_value||0),new H.D(0))):null};
}
module.exports={report,dashboard};
