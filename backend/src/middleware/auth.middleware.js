const jwt=require('jsonwebtoken');
const {query}=require('../config/db');
const E=require('../utils/ApiError');
async function authenticate(req,res,next){try{
 const h=req.headers.authorization||''; if(!h.startsWith('Bearer '))throw E.unauthorized('Please sign in');
 let p;try{p=jwt.verify(h.slice(7),process.env.JWT_ACCESS_SECRET,{issuer:'kirana-erp'});}catch{throw E.unauthorized('Session expired');}
 if(p.type!=='access')throw E.unauthorized();
 const u=(await query('SELECT u.id,u.full_name,u.username,u.email,u.store_id,u.role_id,r.name role_name FROM users u JOIN roles r ON r.id=u.role_id JOIN auth_sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.id=$2 AND NOT s.revoked AND s.expires_at>now() AND u.is_active AND u.token_version=$3',[p.sub,p.sid,p.v])).rows[0];
 if(!u)throw E.unauthorized('Session expired');
 u.permissions=u.role_name==='super_admin'?[]:(await query('SELECT p.code FROM permissions p JOIN role_permissions rp ON rp.permission_id=p.id WHERE rp.role_id=$1',[u.role_id])).rows.map(p=>p.code);
 req.user=u;req.sessionId=p.sid;next();
}catch(e){next(e);}}
module.exports={authenticate};
