const origin=new URL(process.env.PUBLIC_ORIGIN??'http://127.0.0.1:3000');
if(!['http:','https:'].includes(origin.protocol))throw new Error('Invalid PUBLIC_ORIGIN');
for(const route of ['/health/live','/health/ready']){const r=await fetch(new URL(route,origin),{signal:AbortSignal.timeout(10000),redirect:'error'});if(!r.ok)throw new Error('Health check failed: '+route+' '+r.status);const data=await r.json();if(!['ok','ready'].includes(data.status))throw new Error('Unexpected health response');console.log(route+' '+r.status+' '+data.status);}
