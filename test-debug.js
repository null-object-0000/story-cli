const { execSync } = require('node:child_process');
const cmd = "" "" stats;
try {
  const out = execSync(cmd, { cwd: '', encoding: 'utf-8', timeout: 60000 });
  console.log('OUT:', out.slice(0, 300));
} catch (e) {
  console.log('code:', e.status);
  console.log('stdout:', JSON.stringify((e.stdout || '').toString().slice(0, 200)));
  console.log('stderr:', JSON.stringify((e.stderr || '').toString().slice(0, 200)));
  console.log('msg:', e.message.slice(0, 300));
}
