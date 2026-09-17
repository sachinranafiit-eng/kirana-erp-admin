const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();

app.use(helmet({contentSecurityPolicy:{directives:{'style-src':["'self'","'unsafe-inline'",'https://fonts.googleapis.com'],'font-src':["'self'",'https://fonts.gstatic.com','data:'],'upgrade-insecure-requests':null}}}));
app.use(cors({ origin: process.env.CORS_ORIGIN || false }));
app.use((req,res,next)=>{ if(['POST','PUT','PATCH','DELETE'].includes(req.method) && req.headers.origin) { const allowed=process.env.CORS_ORIGIN || `${req.protocol}://${req.get('host')}`; if(req.headers.origin!==allowed)return res.status(403).json({success:false,message:'Cross-origin request blocked'}); } next(); });
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'development' ? 'dev' : 'combined'));
}

app.get('/health', (req, res) => res.json({ success: true, status: 'ok', time: new Date().toISOString() }));

app.use('/api/v1', routes);

app.use(express.static(require('path').resolve(__dirname, '../../frontend/dist')));
app.get(['/','/shop'], (req,res)=>res.sendFile(require('path').resolve(__dirname, '../../frontend/dist/index.html')));
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
