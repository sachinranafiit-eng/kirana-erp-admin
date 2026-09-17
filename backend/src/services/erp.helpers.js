const D = require('decimal.js');
const ApiError = require('../utils/ApiError');
const { query } = require('../config/db');
D.set({precision:28,rounding:D.ROUND_HALF_UP});
const money = v => new D(v ?? 0).toDecimalPlaces(2).toNumber();
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata'}).format(new Date());
function number(v,name,{min=0,max=1e10,scale=3}={}) { let d; try { d=new D(v ?? 0); } catch { throw ApiError.badRequest(name+' must be a valid number'); } if(!d.isFinite() || d.lt(min) || d.gt(max) || d.decimalPlaces()>scale) throw ApiError.badRequest(`${name} must be between ${min} and ${max}, with at most ${scale} decimals`); return d.toNumber(); }
function date(v,name='Date') { if(!/^\d{4}-\d{2}-\d{2}$/.test(v||'') || isNaN(Date.parse(v)) || new Date(v).toISOString().slice(0,10)!==v) throw ApiError.badRequest(`${name} must be a valid YYYY-MM-DD date`); return v; }
function required(v,name) { if(typeof v!=='string'||!v.trim()) throw ApiError.badRequest(`${name} is required`); return v.trim(); }
function can(user,perm) { return user.role_name==='super_admin' || user.permissions?.includes(perm); }
function permit(user,perm) { if(!can(user,perm)) throw ApiError.forbidden(`Permission required: ${perm}`); }
function scope(user,value) { const id=Number(value||user.store_id||1); if(!Number.isInteger(id)||id<1) throw ApiError.badRequest('Choose a store'); if(user.role_name!=='super_admin' && Number(user.store_id)!==id) throw ApiError.forbidden('You cannot access this store'); return id; }
function gstin(v,state) { if(!v) return null; v=String(v).trim().toUpperCase(); if(!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) throw ApiError.badRequest('GSTIN must contain 15 valid characters'); if(state&&v.slice(0,2)!==state) throw ApiError.badRequest('GSTIN and state code do not match'); return v; }
function lineTax({qty,rate,discount=0,gst=0,cess=0,inclusive=false,interstate=false}) {
  qty=number(qty,'Quantity',{min:0.001}); rate=number(rate,'Rate',{scale:2}); discount=number(discount,'Discount',{max:100,scale:2}); gst=number(gst,'GST rate',{max:100,scale:2}); cess=number(cess,'Cess rate',{max:100,scale:2});
  const gross=new D(qty).mul(rate); const discounted=gross.mul(new D(1).minus(new D(discount).div(100)));
  const taxable=money(inclusive ? discounted.div(new D(1).plus(new D(gst+cess).div(100))) : discounted);
  const tax=money(new D(taxable).mul(gst).div(100)); const cessAmount=money(new D(taxable).mul(cess).div(100));
  const cgst=interstate?0:money(new D(tax).div(2)); const sgst=interstate?0:money(new D(tax).minus(cgst));
  return {quantity:qty,rate,discount_pct:discount,gst_rate:gst,cess_rate:cess,discount_amount:money(gross.minus(discounted)),taxable_amount:taxable,cgst_amount:cgst,sgst_amount:sgst,igst_amount:interstate?tax:0,cess_amount:cessAmount,total_amount:money(new D(taxable).plus(tax).plus(cessAmount))};
}
function totals(lines) { const out={}; for(const k of ['taxable_amount','discount_amount','cgst_amount','sgst_amount','igst_amount','cess_amount','total_amount']) out[k]=money(lines.reduce((n,l)=>n.plus(l[k]||0),new D(0))); return out; }
async function insert(c,table,data) { const keys=Object.keys(data); return (await c.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,keys.map(k=>data[k]===undefined?null:data[k]))).rows[0]; }
async function audit(c,user,action,type,id,details={}) { await insert(c,'user_activity_logs',{user_id:user.id,action,entity_type:type,entity_id:String(id),details:JSON.stringify(details)}); }
async function store(c,id) { const s=(await c.query('SELECT * FROM stores WHERE id=$1 AND is_active=true',[id])).rows[0]; if(!s) throw ApiError.badRequest('Store unavailable'); return s; }
async function financialYear(c,on) { const y=Number(on.slice(0,4))-(Number(on.slice(5,7))<4?1:0); const code=`${y}-${String(y+1).slice(-2)}`; await c.query('INSERT INTO financial_years(code,start_date,end_date) VALUES($1,$2,$3) ON CONFLICT(code) DO NOTHING',[code,`${y}-04-01`,`${y+1}-03-31`]); const fy=(await c.query('SELECT * FROM financial_years WHERE code=$1',[code])).rows[0]; if(fy.is_closed) throw ApiError.badRequest('Financial year is closed'); return fy; }
async function invoiceNumber(c,storeId,fy,kind,prefix) { const row=(await c.query('INSERT INTO invoice_sequences(store_id,fy,kind,last_value) VALUES($1,$2,$3,1) ON CONFLICT(store_id,fy,kind) DO UPDATE SET last_value=invoice_sequences.last_value+1 RETURNING last_value',[storeId,fy,kind])).rows[0]; const s=`${prefix}/${fy.slice(2,4)}${fy.slice(-2)}/${String(row.last_value).padStart(5,'0')}`; if(s.length>16) throw ApiError.badRequest('Invoice sequence exceeds 16 characters'); return s; }
async function movement(c,{storeId,productId,batchId=null,qty,type,rate=0,referenceType,referenceId,userId,notes}) {
  const q=number(Math.abs(qty),'Stock quantity',{min:0.001});
  await c.query('SELECT id FROM products WHERE id=$1 FOR UPDATE',[productId]);
  await c.query('INSERT INTO stock(store_id,product_id,batch_id,current_qty) VALUES($1,$2,$3,0) ON CONFLICT(store_id,product_id,batch_id) DO NOTHING',[storeId,productId,batchId]);
  const row=(await c.query('UPDATE stock SET current_qty=current_qty+$1,updated_at=now() WHERE store_id=$2 AND product_id=$3 AND batch_id IS NOT DISTINCT FROM $4 AND current_qty+$1>=0 RETURNING *',[qty,storeId,productId,batchId])).rows[0];
  if(!row) throw ApiError.conflict('Insufficient stock. Refresh the bill and check available quantities.');
  await insert(c,'stock_movements',{store_id:storeId,product_id:productId,batch_id:batchId,movement_type:type,qty_in:qty>0?q:0,qty_out:qty<0?q:0,cost_rate:rate,reference_type:referenceType,reference_id:String(referenceId||''),created_by:userId,notes});
}
async function allocate(c,storeId,productId,qty,on,batchId) {
  const rows=(await c.query(`SELECT s.*,b.expiry_date,b.batch_number,b.cost_price AS batch_cost FROM stock s LEFT JOIN product_batches b ON b.id=s.batch_id WHERE s.store_id=$1 AND s.product_id=$2 AND s.current_qty>0 AND (b.expiry_date IS NULL OR b.expiry_date >= $3::date) ${batchId?'AND s.batch_id=$4':''} ORDER BY b.expiry_date NULLS LAST,s.id FOR UPDATE OF s`,batchId?[storeId,productId,on,batchId]:[storeId,productId,on])).rows;
  let remaining=new D(qty); const result=[];
  for(const row of rows) { const take=D.min(remaining,row.current_qty); if(take.gt(0)) result.push({...row,quantity:take.toNumber()}); remaining=remaining.minus(take); if(remaining.lte(0))break; }
  if(remaining.gt(0)) throw ApiError.conflict('Not enough unexpired stock for this item'); return result;
}
async function balance(c,type,id) {
  const isCustomer=type==='customer'; const party=(await c.query(`SELECT * FROM ${isCustomer?'customers':'suppliers'} WHERE id=$1`,[id])).rows[0]; if(!party)throw ApiError.notFound('Party not found');
  const invoices=(await c.query(`SELECT COALESCE(sum(total_amount),0) v FROM ${isCustomer?'sales':'purchases'} WHERE ${isCustomer?'customer_id':'supplier_id'}=$1 ${isCustomer?"AND status='completed'":''}`,[id])).rows[0].v;
  const payments=(await c.query('SELECT COALESCE(sum(amount),0) v FROM payments WHERE party_type=$1 AND party_id=$2',[type,id])).rows[0].v;
  const notes=(await c.query(`SELECT COALESCE(sum(amount),0) v FROM ${isCustomer?'credit_notes':'debit_notes'} WHERE ${isCustomer?'customer_id':'supplier_id'}=$1`,[id])).rows[0].v;
  return money(new D(party.opening_balance).plus(invoices).minus(payments).minus(notes));
}
module.exports={D,money,today,number,date,required,can,permit,scope,gstin,lineTax,totals,insert,audit,store,financialYear,invoiceNumber,movement,allocate,balance};
