const router=require('express').Router();
const multer=require('multer');
const {parse}=require('csv-parse/sync');
const Excel=require('exceljs');
const path=require('path');
const crypto=require('crypto');
const {authenticate}=require('../middleware/auth.middleware');
const {requirePermission:permit}=require('../middleware/rbac.middleware');
const wrap=require('../utils/asyncHandler');
const E=require('../utils/ApiError');
const H=require('../services/erp.helpers');
const db=require('../config/db');
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1}});
const normalize=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const fields={name:['name','product','productname','item','itemname','description'],sku:['sku','itemcode','productcode'],barcode:['barcode','ean'],unit:['unit','uom'],category:['category','itemcategory'],hsnCode:['hsn','hsncode','hsnsac'],gstRate:['gstrate','gst','gstpercent'],cessRate:['cessrate','cess'],costPrice:['costprice','purchaseprice','purchaserate','rate'],mrp:['mrp'],salePrice:['saleprice','sellingprice'],openingStock:['openingstock','stock'],quantity:['quantity','qty'],freeQuantity:['freequantity','freeqty'],discountPct:['discountpct','discount','discountpercent'],batchNumber:['batchnumber','batch','batchno'],expiryDate:['expirydate','expiry'],mfgDate:['mfgdate','manufacturingdate'],gstin:['gstin','suppliergstin'],invoiceNo:['invoiceno','invoicenumber','supplierinvoiceno'],invoiceDate:['invoicedate','supplierinvoicedate'],taxable:['taxable','taxablevalue','taxableamount'],cgst:['cgst','cgstamount'],sgst:['sgst','sgstamount'],igst:['igst','igstamount']};
function mapRow(raw){const r={};for(const [key,aliases]of Object.entries(fields)){for(const [k,v]of Object.entries(raw)){if(aliases.includes(normalize(k))){r[key]=typeof v==='object'?v?.text||v?.result||'':v;break;}}}return r;}
async function extract(file){
 const ext=path.extname(file.originalname).toLowerCase();let raw=[],sourceText='';
 if(ext==='.csv')raw=parse(file.buffer.toString('utf8').replace(/^\uFEFF/,''),{columns:true,skip_empty_lines:true,trim:true,bom:true,relax_column_count:false});
 else if(ext==='.xlsx'){
  const wb=new Excel.Workbook();await wb.xlsx.load(file.buffer);const sheet=wb.worksheets[0];if(!sheet)throw E.badRequest('Workbook has no sheet');if(sheet.rowCount>2001)throw E.badRequest('Limit each import to 2,000 rows');
  const headers=sheet.getRow(1).values;sheet.eachRow((row,i)=>{if(i===1)return;const r={};row.eachCell((cell,c)=>r[headers[c]]=cell.type===Excel.ValueType.Date?cell.value.toISOString().slice(0,10):cell.text);raw.push(r);});
 }else if(ext==='.pdf'){
  const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');const document=await pdfjs.getDocument({data:new Uint8Array(file.buffer),useSystemFonts:true,isEvalSupported:false}).promise;
  if(document.numPages>30)throw E.badRequest('Limit each PDF import to 30 pages');
  for(let n=1;n<=document.numPages;n++){const page=await document.getPage(n);const text=await page.getTextContent();const lines=new Map();for(const item of text.items){const y=Math.round(item.transform[5]/3)*3;const line=lines.get(y)||[];line.push({x:item.transform[4],str:item.str});lines.set(y,line);}sourceText += [...lines.entries()].sort((a,b)=>b[0]-a[0]).map(([,items])=>items.sort((a,b)=>a.x-b.x).map(i=>i.str).join('  ')).join('\n')+'\n';}
  await document.destroy();
  // Extract a table only when the document exposes a recognizable header row.
  const lines=sourceText.split('\n').map(s=>s.trim()).filter(Boolean);const headerIndex=lines.findIndex(s=>/\b(sku|barcode)\b/i.test(s)&&/\b(name|description|item)\b/i.test(s));
  if(headerIndex>=0){const headers=lines[headerIndex].split(/\s{2,}|\t/);for(const line of lines.slice(headerIndex+1)){const values=line.split(/\s{2,}|\t/);if(values.length===headers.length)raw.push(Object.fromEntries(headers.map((h,i)=>[h,values[i]])));}}
 }else if(ext==='.json'){
  const j=JSON.parse(file.buffer.toString('utf8'));if(Array.isArray(j))raw=j;else{const b2b=j.data?.docdata?.b2b||j.docdata?.b2b;if(!b2b)throw E.badRequest('Use a JSON row array or the GST portal GSTR-2B B2B structure');for(const s of b2b)for(const inv of s.inv||[]){const sums={taxable:0,cgst:0,sgst:0,igst:0};for(const i of inv.items||[]){for(const [k,field]of Object.entries({taxable:'txval',cgst:'cgst',sgst:'sgst',igst:'igst'}))sums[k]+=Number(i[field]||0);}const d=(inv.dt||'').split('-');raw.push({gstin:s.ctin,invoiceNo:inv.inum,invoiceDate:d[0]?.length===2?d.reverse().join('-'):inv.dt,...sums});}}
 }else throw E.badRequest('Upload CSV, XLSX, PDF, or GSTR-2B JSON');
 if(raw.length>2000)throw E.badRequest('Limit each import to 2,000 rows');return {rows:raw.map(mapRow),sourceText,ext};
}
router.use(authenticate);
router.post('/preview',permit('imports.manage'),upload.single('file'),wrap(async(req,res)=>{
 if(!req.file)throw E.badRequest('Select a file');const type=req.body.type||'products';if(!['products','purchase'].includes(type))throw E.badRequest('Choose products or purchase');
 const result=await extract(req.file);const catalog=(await db.query('SELECT p.id,p.name,p.sku,(SELECT array_agg(barcode) FROM product_barcodes WHERE product_id=p.id) barcodes FROM products p')).rows;
 const rows=result.rows.map((r,index)=>{const p=catalog.find(p=>(r.sku&&p.sku===String(r.sku))||(r.barcode&&p.barcodes?.includes(String(r.barcode)))||p.name.toLowerCase()===String(r.name||'').toLowerCase());return {...r,productId:p?.id||null,rowNumber:index+2,issue:type==='purchase'&&!p?'Match or create this product first':!r.name?'Product name is missing':''};});
 const job=await H.insert(db,'import_jobs',{type:result.ext.slice(1),file_name:req.file.originalname,status:'preview',total_rows:rows.length,error_rows:rows.filter(r=>r.issue).length,result_summary:JSON.stringify({target:type,rows}),created_by:req.user.id});
 res.json({success:true,data:{jobId:job.id,rows,sourceText:result.sourceText,warning:!rows.length?'No reliable item table could be extracted. Review the text and paste corrected CSV below. Image-only PDFs need OCR before import.':'Review every price, quantity and tax rate before confirming.'}});
}));
router.post('/parse-csv',permit('imports.manage'),wrap(async(req,res)=>{const result=await extract({originalname:'review.csv',buffer:Buffer.from(req.body.csv||'')});res.json({success:true,data:result.rows});}));
router.post('/commit-products',permit('imports.manage'),permit('products.add'),wrap(async(req,res)=>{
 const b=req.body;if(!Array.isArray(b.rows)||!b.rows.length||b.rows.length>2000)throw E.badRequest('Add 1–2,000 reviewed rows');
 const result=await db.withTransaction(async c=>{
  const job=(await c.query('SELECT * FROM import_jobs WHERE id=$1 AND created_by=$2 FOR UPDATE',[b.jobId,req.user.id])).rows[0];if(!job)throw E.notFound('Import preview not found');if(job.status==='committed')return job.result_summary;
  const st=H.scope(req.user,b.storeId);const ids=[];const seen=new Set();
  for(const r of b.rows){const name=H.required(r.name,'Item name'),sku=H.required(String(r.sku||''),'SKU');if(seen.has(sku))throw E.badRequest('Duplicate SKU in this file: '+sku);seen.add(sku);
   const unit=(await c.query('SELECT id FROM units WHERE lower(short_code)=lower($1) OR lower(name)=lower($1)',[r.unit||'pcs'])).rows[0];if(!unit)throw E.badRequest('Unknown unit: '+r.unit);
   const mrp=H.number(r.mrp,'MRP',{scale:2}),price=H.number(r.salePrice,'Selling price',{scale:2}),cost=H.number(r.costPrice,'Cost price',{scale:2});if(price>mrp)throw E.badRequest(name+': selling price exceeds MRP');
   const category=(await c.query('SELECT id FROM categories WHERE lower(name)=lower($1)',[r.category||'Grocery'])).rows[0];if(!category)throw E.badRequest('Create the category first: '+r.category);
   const p=await H.insert(c,'products',{name,sku,unit_id:unit.id,category_id:category.id,hsn_code:r.hsnCode||null,gst_rate:H.number(r.gstRate||0,'GST',{max:100,scale:2}),cess_rate:H.number(r.cessRate||0,'Cess',{max:100,scale:2}),cost_price:cost,mrp,sale_price:price,created_by:req.user.id});
   const code=String(r.barcode||('K'+p.id.toString().padStart(10,'0')));await H.insert(c,'product_barcodes',{product_id:p.id,barcode:code,is_system_generated:!r.barcode});const qty=H.number(r.openingStock||0,'Opening stock');if(qty)await H.movement(c,{storeId:st,productId:p.id,qty,type:'opening',rate:cost,referenceType:'import',referenceId:job.id,userId:req.user.id});ids.push(p.id);
  }
  const result={created:ids.length,productIds:ids};await c.query("UPDATE import_jobs SET status='committed',result_summary=$1 WHERE id=$2",[JSON.stringify(result),job.id]);await H.audit(c,req.user,'import.commit','import',job.id,result);return result;
 });res.json({success:true,data:result});
}));
router.post('/gstr2b',permit('gst.manage'),upload.single('file'),wrap(async(req,res)=>{
 if(!req.file)throw E.badRequest('Select GSTR-2B CSV, XLSX, or JSON');const period=req.body.period;if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period||''))throw E.badRequest('Select a tax period');const st=H.scope(req.user,req.body.storeId);
 const input=await extract(req.file);if(!input.rows.length)throw E.badRequest('No GSTR-2B rows found');
 const books=(await db.query("SELECT id,supplier_snapshot->>'gstin' gstin,supplier_invoice_no,TO_CHAR(supplier_invoice_date,'YYYY-MM-DD') invoice_date,taxable_amount,cgst_amount,sgst_amount,igst_amount FROM purchases WHERE store_id=$1 AND TO_CHAR(supplier_invoice_date,'YYYY-MM')=$2",[st,period])).rows;
 const key=(gst,inv)=>String(gst||'').toUpperCase().trim()+'|'+String(inv||'').toUpperCase().trim();const seen=new Set(),matched=new Set();
 const result=input.rows.map(r=>{if(!r.gstin||!r.invoiceNo)throw E.badRequest('Every row needs GSTIN and invoiceNo');const k=key(r.gstin,r.invoiceNo);if(seen.has(k))return {...r,status:'Duplicate in file'};seen.add(k);const p=books.find(p=>key(p.gstin,p.supplier_invoice_no)===k);if(!p)return {...r,status:'Missing in books'};matched.add(p.id);const differences=[];for(const [field,col]of Object.entries({taxable:'taxable_amount',cgst:'cgst_amount',sgst:'sgst_amount',igst:'igst_amount'})){const value=H.number(r[field]||0,field,{scale:2});if(new H.D(p[col]).minus(value).abs().gt(.01))differences.push(field);}if(r.invoiceDate!==p.invoice_date)differences.push('invoice date');return {...r,purchaseId:p.id,status:differences.length?'Mismatch':'Matched',differences:differences.join(', ')};});
 for(const p of books)if(!matched.has(p.id))result.push({gstin:p.gstin,invoiceNo:p.supplier_invoice_no,invoiceDate:p.invoice_date,taxable:p.taxable_amount,cgst:p.cgst_amount,sgst:p.sgst_amount,igst:p.igst_amount,status:'Missing in GSTR-2B'});
 await H.insert(db,'gst_reconciliations',{store_id:st,period,data:JSON.stringify(result),created_by:req.user.id});res.json({success:true,data:result});
}));
module.exports=router;
