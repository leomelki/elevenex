const {createServer}=require('node:http');
const {WebSocketServer}=require('../../backend/node_modules/ws');
module.exports=async()=>{
 const server=createServer((request,response)=>{if(request.url.startsWith('/download-test')){response.writeHead(200,{'content-type':'text/plain','content-disposition':'attachment; filename=report.txt'});response.end('browser download fixture');return;}response.writeHead(200,{'content-type':'text/html','access-control-allow-origin':'*'});response.end('<!doctype html><html><body style="margin:20px"><h1>Task browser test site</h1><div id="scroll-target" style="height:80px;overflow:auto"><div style="height:500px">Nested scroll area</div></div><button style="margin:60px" onclick="window.clicks++">Pick this</button><input type="password"><input autocomplete="cc-number"><iframe src="about:blank"></iframe><script>window.clicks=0</script></body></html>');});
 const sockets=new WebSocketServer({server,maxPayload:1024});sockets.on('connection',socket=>socket.on('message',message=>socket.send(message.toString())));
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 return {url:'http://127.0.0.1:'+server.address().port,async close(){for(const socket of sockets.clients)socket.terminate();await new Promise(resolve=>sockets.close(resolve));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
};
