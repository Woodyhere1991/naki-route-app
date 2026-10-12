// Local static demo only: binds loopback, serves an explicit public-file allowlist.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),port=Number(process.env.NAKI_DEMO_PORT)||8788;
http.createServer((req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1');let name;
 try{name=decodeURIComponent(url.pathname);}catch{res.writeHead(400);return res.end();}
 if(name.startsWith('/demo-api')){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({bookings:[],customers:[],towns:[],demo:true}));}
 if(name==='/')name='/index.html';
 const file=path.resolve(root,'.'+name),allowed=['/index.html','/sw.js','/manifest.webmanifest'].includes(name)||name.startsWith('/assets/');
 if(req.method!=='GET'||!allowed||!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end('Not found');}
 const ext=path.extname(file),types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
 res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});fs.createReadStream(file).pipe(res);
}).listen(port,'127.0.0.1',()=>console.log(`Synthetic demo: http://127.0.0.1:${port}/?suggestions-demo=1`));
