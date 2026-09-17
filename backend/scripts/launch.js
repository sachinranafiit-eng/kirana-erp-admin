const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const envPath = path.resolve(__dirname,'../.env');
fs.mkdirSync(path.resolve(__dirname,'../../data'), { recursive: true });
if (!fs.existsSync(envPath)) {
  fs.writeFileSync(envPath, ['DB_DRIVER=pglite','PORT=4000','HOST=127.0.0.1','NODE_ENV=production',
    'JWT_ACCESS_SECRET='+crypto.randomBytes(48).toString('hex'),
    'JWT_REFRESH_SECRET='+crypto.randomBytes(48).toString('hex'),
    'JWT_CUSTOMER_SECRET='+crypto.randomBytes(48).toString('hex'),
    'SETUP_KEY='+crypto.randomBytes(9).toString('hex')].join('\n')+'\n',{mode:0o600});
}
require('dotenv').config({path:envPath});
require('../src/server');
