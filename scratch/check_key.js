const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const match = env.match(/OPENAI_API_KEY=(.*)/);
if (match) {
    const key = match[1];
    console.log('Key length:', key.length);
    console.log('Key hex:', Buffer.from(key).toString('hex'));
    console.log('Ends with RC8A:', key.endsWith('RC8A'));
} else {
    console.log('Key not found');
}
