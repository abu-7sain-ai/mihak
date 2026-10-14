// وضع التجربة: أسعار وقرارات وهمية، بدون مفاتيح وبدون إنترنت.
// التشغيل: npm run demo  ثم افتح http://localhost:3000
process.env.DEMO = '1';
process.env.DB_FILE = process.env.DB_FILE || 'db-demo.json';
require('./server').start();
