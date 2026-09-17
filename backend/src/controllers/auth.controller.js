const bcrypt=require('bcryptjs');
const jwt=require('jsonwebtoken');
const crypto=require('crypto');
const {query,withTransaction}=require('../config/db');
const wrap=require('../utils/asyncHandler');
const E=require('../utils/ApiError');
const H=require('../services/erp.helpers');
const sign=(u,sid,type='access')=>jwt.sign({sub:u.id,sid,v:u.token_version,type},process.env[type==='access'?'JWT_ACCESS_SECRET':'JWT_REFRESH_SECRET'],{expiresIn:type==='access'?'15m':'7d',issuer:'kirana-erp'});
const publicUser=u=>({id:u.id,fullName:u.full_name,username:u.username,email:u.email,role:u.role_name,storeId:u.store_id,permissions:u.permissions||[]});
const login=wrap(async(req,res)=>{
 const {username,password}=req.body;
 if(!username||!password)throw E.badRequest('Username and password are required');
 const u=(await query('SELECT u.*,r.name role_name FROM users u JOIN roles r ON r.id=u.role_id WHERE username=$1',[username])).rows[0];
 const ok=u&&u.is_active&&await bcrypt.compare(password,u.password_hash);
 await query('INSERT INTO login_logs(user_id,username_tried,success,ip_address) VALUES($1,$2,$3,$4)',[u?.id||null,String(username).slice(0,50),!!ok,req.ip]);
 if(!ok)throw E.unauthorized('Invalid username or password');
 const sid=crypto.randomUUID();
 await query("INSERT INTO auth_sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",[sid,u.id]);
 await query('UPDATE users SET last_login_at=now() WHERE id=$1',[u.id]);
 res.json({success:true,data:{user:publicUser(u),accessToken:sign(u,sid),refreshToken:sign(u,sid,'refresh')}});
});
const refresh=wrap(async(req,res)=>{
 let p; try{p=jwt.verify(req.body.refreshToken,process.env.JWT_REFRESH_SECRET,{issuer:'kirana-erp'});}catch{throw E.unauthorized('Session expired');}
 if(p.type!=='refresh')throw E.unauthorized();
 const u=(await query('SELECT u.* FROM users u JOIN auth_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.id=$2 AND NOT s.revoked AND s.expires_at>now() AND u.is_active AND u.token_version=$3',[p.sub,p.sid,p.v])).rows[0];
 if(!u)throw E.unauthorized('Session expired');
 res.json({success:true,data:{accessToken:sign(u,p.sid)}});
});
const me=wrap(async(req,res)=>res.json({success:true,data:publicUser(req.user)}));
const logout=wrap(async(req,res)=>{await query('UPDATE auth_sessions SET revoked=true WHERE id=$1',[req.sessionId]);res.json({success:true,message:'Signed out'});});
const changePassword=wrap(async(req,res)=>{
 const b=req.body; if(typeof b.newPassword!=='string'||b.newPassword.length<12||Buffer.byteLength(b.newPassword)>72)throw E.badRequest('Use a password of 12–72 bytes');
 const u=(await query('SELECT password_hash FROM users WHERE id=$1',[req.user.id])).rows[0];
 if(!await bcrypt.compare(b.currentPassword||'',u.password_hash))throw E.unauthorized('Current password is incorrect');
 await query('UPDATE users SET password_hash=$1,token_version=token_version+1 WHERE id=$2',[await bcrypt.hash(b.newPassword,12),req.user.id]);
 res.json({success:true,message:'Password changed. Sign in again.'});
});
const setupStatus=wrap(async(req,res)=>res.json({success:true,data:{needsSetup:!(await query('SELECT 1 FROM users LIMIT 1')).rows.length}}));
const setup=wrap(async(req,res)=>{
 const b=req.body; if(typeof b.setupKey!=='string'||!process.env.SETUP_KEY||b.setupKey.length!==process.env.SETUP_KEY.length||!crypto.timingSafeEqual(Buffer.from(b.setupKey),Buffer.from(process.env.SETUP_KEY)))throw E.forbidden('Enter the installation code shown in the server terminal');
 if(!b.password||b.password.length<12||Buffer.byteLength(b.password)>72)throw E.badRequest('Use a password of 12–72 bytes');
 const result=await withTransaction(async c=>{
  await c.query('LOCK TABLE users IN EXCLUSIVE MODE');
  if((await c.query('SELECT 1 FROM users LIMIT 1')).rows.length)throw E.conflict('Setup has already been completed');
  const state=String(b.stateCode||'05').padStart(2,'0'); const gstin=H.gstin(b.gstin,state);
  if(b.registrationType==='regular'&&!gstin)throw E.badRequest('GSTIN is required for a regular registered business');
  await c.query('UPDATE stores SET name=$1,address=$2,state_code=$3,state=$4,gstin=$5,registration_type=$6,phone=$7 WHERE id=1',[H.required(b.storeName,'Store name'),b.address||'',state,b.state||'Uttarakhand',gstin,b.registrationType||'unregistered',b.phone||'']);
  return H.insert(c,'users',{full_name:H.required(b.fullName,'Your name'),username:H.required(b.username,'Username'),password_hash:await bcrypt.hash(b.password,12),role_id:1,store_id:1});
 }); res.status(201).json({success:true,data:{username:result.username}});
});
module.exports={login,refresh,me,logout,changePassword,setupStatus,setup};
