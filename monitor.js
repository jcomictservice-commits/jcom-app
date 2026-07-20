// JCOM Auto-Monitor System
const https = require('https');
const http = require('http');
const fs = require('fs');
const { execSync } = require('child_process');

const BOT_TOKEN = '8889210186:AAGX-ShLk_RECzcqaFxEfja8IIR2h-DC0jc';
const CHAT_ID = '7043361685';
const FLAG_DIR = '/root/jcom-api/monitor-flags';

if (!fs.existsSync(FLAG_DIR)) fs.mkdirSync(FLAG_DIR, { recursive: true });

function sendTelegram(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text: text });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: '/bot' + BOT_TOKEN + '/sendMessage',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, r => { let d = ''; r.on('data', x => d += x); r.on('end', () => resolve(d)); });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

function httpGet(path) {
  return new Promise((resolve) => {
    const req = https.get('https://165.22.242.64.nip.io' + path, { timeout: 8000 }, r => {
      let d = ''; r.on('data', x => d += x); r.on('end', () => resolve({ status: r.statusCode, data: d }));
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

// ===== 1. CHECK SERVER HEALTH (every 10 min) =====
async function checkServerHealth() {
  const flagFile = FLAG_DIR + '/server-down.flag';
  const res = await httpGet('/ping');

  if (res.status !== 200) {
    // Server down - try restart
    if (!fs.existsSync(flagFile)) {
      fs.writeFileSync(flagFile, new Date().toISOString());
      await sendTelegram('🔴 JCOM Server ລົ້ມ! (Status: ' + res.status + ')\nກຳລັງພະຍາຍາມ Restart...\n' + new Date().toLocaleString());
      try {
        execSync('pm2 restart jcom-api');
        await sendTelegram('🔄 ພະຍາຍາມ Restart PM2 ແລ້ວ - ກວດຄືນໃນ 1 ນາທີ');
      } catch (e) {
        await sendTelegram('❌ Restart ບໍ່ສຳເລັດ: ' + e.message);
      }
    }
  } else {
    // Server OK
    if (fs.existsSync(flagFile)) {
      fs.unlinkSync(flagFile);
      await sendTelegram('✅ JCOM Server ກັບມາອອນລາຍແລ້ວ!\n' + new Date().toLocaleString());
    }
  }
}

// ===== 2. CHECK SALES SYNC (data not older than 1 hour during business hours) =====
async function checkSalesSync() {
  const flagFile = FLAG_DIR + '/sync-stale.flag';
  const res = await httpGet('/sales/dashboard');
  if (res.status !== 200) return; // handled by server health check

  try {
    const json = JSON.parse(res.data);
    const monthly = json.data.monthly || [];
    if (!monthly.length) return;

    const latestDate = monthly[0].date;
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();
    const hour = now.getHours();

    // Only alert during business hours (8am-8pm) and if data is not from today
    if (hour >= 8 && hour <= 20 && latestDate !== today) {
      if (!fs.existsSync(flagFile)) {
        fs.writeFileSync(flagFile, new Date().toISOString());
        await sendTelegram('⚠️ JCOM ຍອດຂາຍ ບໍ່ອັບເດດ!\nຂໍ້ມູນລ່າສຸດ: ' + latestDate + '\nມື້ນີ້: ' + today + '\n\nກະລຸນາກວດ Server ຮ້ານ ວ່າຄອມເປີດຢູ່ ຫຼືບໍ່, Task Scheduler ຮັນຢູ່ ຫຼືບໍ່\n' + now.toLocaleString());
      }
    } else if (latestDate === today && fs.existsSync(flagFile)) {
      fs.unlinkSync(flagFile);
      await sendTelegram('✅ JCOM ຍອດຂາຍ Sync ກັບຄືນປົກກະຕິແລ້ວ!');
    }
  } catch (e) { console.error('checkSalesSync error:', e.message); }
}

// ===== 3. CHECK DISK SPACE =====
async function checkDiskSpace() {
  const flagFile = FLAG_DIR + '/disk-warning.flag';
  try {
    const output = execSync("df -h / | tail -1 | awk '{print $5}'").toString().trim();
    const percent = parseInt(output.replace('%', ''));

    if (percent >= 85) {
      if (!fs.existsSync(flagFile)) {
        fs.writeFileSync(flagFile, new Date().toISOString());
        await sendTelegram('⚠️ JCOM VPS Disk ໃກ້ເຕັມ! (' + percent + '%)\nກະລຸນາລຶບໄຟລ໌ບໍ່ຈຳເປັນ ຫຼື ຂະຫຍາຍ Disk\n' + new Date().toLocaleString());
      }
    } else if (fs.existsSync(flagFile)) {
      fs.unlinkSync(flagFile);
    }
  } catch (e) { console.error('checkDiskSpace error:', e.message); }
}

// ===== 4. DAILY REPORT (called separately via cron at specific time) =====
async function sendDailyReport() {
  const res = await httpGet('/sales/dashboard');
  const diskOutput = execSync("df -h / | tail -1 | awk '{print $5}'").toString().trim();

  let report = '📊 JCOM ລາຍງານປະຈຳວັນ - ' + new Date().toLocaleDateString() + '\n\n';

  try {
    const json = JSON.parse(res.data);
    const today = json.data.today_total;
    report += '💰 ຍອດຂາຍມື້ວານ: ₭' + (today.total || 0).toLocaleString() + ' (' + (today.bills || 0) + ' ບິນ)\n\n';

    const officers = (json.data.today_by_officer || []).slice(0, 5);
    report += '🏆 Top 5 ພະນັກງານ (ເດືອນ):\n';
    officers.forEach((o, i) => {
      report += (i + 1) + '. ' + o.officer + ': ₭' + o.total.toLocaleString() + '\n';
    });
  } catch (e) {
    report += '❌ ບໍ່ສາມາດດຶງຂໍ້ມູນຍອດຂາຍ\n';
  }

  report += '\n💾 Disk VPS: ' + diskOutput + ' ໃຊ້ແລ້ວ\n';
  report += '🖥 Server Status: ' + (res.status === 200 ? '✅ Online' : '🔴 Down') + '\n';

  await sendTelegram(report);
}

// ===== MAIN =====
const mode = process.argv[2] || 'check';

(async () => {
  if (mode === 'check') {
    await checkServerHealth();
    await checkSalesSync();
    await checkDiskSpace();
    console.log('Monitor check done:', new Date().toISOString());
  } else if (mode === 'daily-report') {
    await sendDailyReport();
    console.log('Daily report sent:', new Date().toISOString());
  }
})();
