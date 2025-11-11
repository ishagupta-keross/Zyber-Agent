// src/index.ts
import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const prisma = new PrismaClient();

// Middleware
app.use(express.json());
app.use(cors());

// Auth
const PARENT_SECRET = process.env.PARENT_SECRET || 'my-secret-token';

// Helper: Get start/end of day
function getDateRange(dateStr?: string) {
  if (dateStr) {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      throw new Error('Invalid date format. Use YYYY-MM-DD.');
    }
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { start, end };
  }
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

// Helper: Format seconds
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// POST: Receive activity logs (supports screenTime flag)
// 🌐 Called by C# worker at:
//    - LOCAL:  http://localhost:3001/zyberhero-backend/api/activity
//    - PROD:   https://ikoncloud-dev.keross.com/zyberhero-backend/api/activity
app.post('/api/activity', async (req, res) => {
  const authHeader = req.headers.authorization;

  if (authHeader !== `Bearer ${PARENT_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const {
      timestamp,
      localTimestamp,
      machineName,
      userName,
      appName,
      windowTitle,
      durationSeconds,
      executablePath,
      screenTime = false
    } = req.body;

    if (!appName) {
      return res.status(400).json({ error: 'Missing required field: appName' });
    }

    const log = await prisma.activityLog.create({
      data: {
        timestamp: timestamp ? new Date(timestamp) : new Date(),
        localTimestamp: localTimestamp ? new Date(localTimestamp) : null,
        machineName,
        userName,
        appName,
        windowTitle: windowTitle || '',
        durationSeconds: durationSeconds || 0,
        executablePath: executablePath || '',
        screenTime
      }
    });

    const label = screenTime ? '[SCREEN TIME]' : '[FOCUSED]';
    console.log(
      `✅ ${label} ${appName} - "${windowTitle || ''}" | ` +
      `Duration: ${durationSeconds || 0}s | ` +
      `Time: ${new Date(timestamp).toLocaleTimeString()}`
    );

    res.status(201).json({ id: log.id });
  } catch (error) {
    console.error('DB Error:', error);
    res.status(500).json({ error: 'Failed to save activity' });
  }
});

// GET: All recent logs
app.get('/api/activity', async (req, res) => {
  const logs = await prisma.activityLog.findMany({
    orderBy: { timestamp: 'desc' },
    take: 100
  });
  res.json(logs);
});

// GET: Daily comparison — Focused vs Screen Time
// 🌐 Endpoint: /api/summary/daily-comparison
app.get('/api/summary/daily-comparison', async (req, res) => {
  try {
    const { start, end } = getDateRange(req.query.date as string | undefined);

    const logs = await prisma.activityLog.findMany({
      where: {
        timestamp: {
          gte: start,
          lt: end,
        },
        durationSeconds: { gt: 0 },
      },
      select: {
        appName: true,
        windowTitle: true,
        durationSeconds: true,
        screenTime: true,
      },
    });

    const appMap: Record<string, { focused: number; screen: number; latestWindowTitle: string }> = {};

    for (const log of logs) {
      let app = log.appName || 'unknown';
       if (app === 'chrome' || app === 'msedge') {
    const title = log.windowTitle.toLowerCase();
    if (title.includes('google chat') || title.includes('chat.google.com')) {
      app = 'google-chat';
    } else if (title.includes('youtube')) {
      app = 'youtube';
    } else if (title.includes('gmail')) {
      app = 'gmail';
    } else if (title.includes('netflix')) {
      app = 'netflix';
    } else {
      app = 'chrome-other';
    }
  }

      if (!appMap[app]) {
        appMap[app] = { focused: 0, screen: 0, latestWindowTitle: log.windowTitle || app };
      }

      const duration = log.durationSeconds ?? 0;
      if (log.screenTime) {
        appMap[app].screen += duration;
      } else {
        appMap[app].focused += duration;
      }
      if (!appMap[app].latestWindowTitle || appMap[app].latestWindowTitle === app) {
        appMap[app].latestWindowTitle = log.windowTitle || app;
      }
    }

    const result = Object.entries(appMap).map(([app, times]) => ({
      app,
      windowTitle: times.latestWindowTitle,
      focusedTimeSeconds: times.focused,
      screenTimeSeconds: times.screen,
      focusedTimeFormatted: formatDuration(times.focused),
      screenTimeFormatted: formatDuration(times.screen),
      totalTimeSeconds: times.focused + times.screen,
    })).sort((a, b) => b.totalTimeSeconds - a.totalTimeSeconds);

    res.json({
      date: start.toISOString().split('T')[0],
      apps: result,
      summary: {
        totalFocusedSeconds: result.reduce((sum, a) => sum + a.focusedTimeSeconds, 0),
        totalScreenSeconds: result.reduce((sum, a) => sum + a.screenTimeSeconds, 0),
      },
    });
  } catch (error: any) {
    console.error('Summary error:', error);
    if (error.message?.includes('Invalid date')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// GET /api/screen-time/total?date=YYYY-MM-DD
// 🌐 Endpoint: /api/screen-time/total
app.get('/api/screen-time/total', async (req, res) => {
  try {
    const { start, end } = getDateRange(req.query.date as string | undefined);

    const screenTimeTotal = await prisma.activityLog.aggregate({
      _sum: { durationSeconds: true },
      where: { screenTime: true, timestamp: { gte: start, lt: end } },
    });

    const focusedTimeTotal = await prisma.activityLog.aggregate({
      _sum: { durationSeconds: true },
      where: { screenTime: false, timestamp: { gte: start, lt: end } },
    });

    const totalScreen = screenTimeTotal._sum?.durationSeconds ?? 0;
    const totalFocused = focusedTimeTotal._sum?.durationSeconds ?? 0;

    res.json({
      date: start.toISOString().split('T')[0],
      totalScreenTimeSeconds: totalScreen,
      totalScreenTimeFormatted: formatDuration(totalScreen),
      totalFocusedTimeSeconds: totalFocused,
      totalFocusedTimeFormatted: formatDuration(totalFocused),
      totalTimeSeconds: totalScreen + totalFocused,
    });
  } catch (error: any) {
    console.error('Total screen time error:', error);
    res.status(500).json({ error: 'Failed to compute total screen time' });
  }
});

// POST: Kill command
// 🌐 Called by frontend at:
//    - LOCAL:  http://localhost:3001/api/commands/kill
//    - PROD:   https://ikoncloud-dev.keross.com/zyberhero-backend/api/commands/kill
// POST /api/commands/kill
// POST /api/commands/kill
app.post('/api/commands/kill', async (req, res) => {
  const { machineName, appName } = req.body;

  if (!machineName || !appName) {
    return res.status(400).json({ error: 'machineName and appName required' });
  }

  try {
    // ✅ Just CREATE a new command (no upsert, no constraint needed)
    await prisma.controlCommand.create({
      data: {
        machineName,
        appName: appName.toLowerCase(),
        action: 'kill',
        isActive: true,
      },
    });

    res.json({ success: true, message: `Kill command sent` });
  } catch (error) {
    console.error('Kill command error:', error); // 👈 Check this in terminal
    res.status(500).json({ error: 'Failed to create kill command' });
  }
});
// POST: Schedule command
// 🌐 Endpoint: /api/commands/schedule
app.post('/api/commands/schedule', async (req, res) => {
  const { machineName, appName, schedule } = req.body;

  if (!machineName || !appName || !schedule) {
    return res.status(400).json({ error: 'machineName, appName, and schedule required' });
  }

  try {
    await prisma.controlCommand.create({
      data: {
        machineName,
        appName: appName.toLowerCase(),
        action: 'schedule',
        schedule,
        isActive: true,
      },
    });

    res.json({ success: true, message: `Schedule set for ${appName}` });
  } catch (error) {
    console.error('Schedule command error:', error);
    res.status(500).json({ error: 'Failed to create schedule command' });
  }
});

// POST /api/commands/relaunch
// POST /api/commands/relaunch
// POST /api/commands/relaunch
// POST /api/commands/relaunch
// POST /api/commands/relaunch
// POST /api/commands/relaunch
app.post('/api/commands/relaunch', async (req, res) => {
  const { machineName, appName } = req.body;

  if (!machineName || !appName) {
    return res.status(400).json({ error: 'machineName and appName required' });
  }

  try {
    // Deactivate ALL kill commands for this app (safe even with duplicates)
    await prisma.controlCommand.updateMany({
      where: {
        machineName,
        appName: appName.toLowerCase(),
        action: 'kill',
      },
       data:{ isActive: false },
    });

    // Create a ONE-TIME relaunch command
    await prisma.controlCommand.create({
      data: {
        machineName,
        appName: appName.toLowerCase(),
        action: 'relaunch',
        isActive: true,
      },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Relaunch command error:', error);
    res.status(500).json({ error: 'Failed to create relaunch command' });
  }
});
// GET: Pending commands for a machine
// 🌐 Called by C# worker at:
//    - LOCAL:  http://localhost:3001/zyberhero-backend/api/commands/pending?machineName=...
//    - PROD:   https://ikoncloud-dev.keross.com/zyberhero-backend/api/commands/pending?machineName=...
// GET /api/commands/pending
app.get('/api/commands/pending', async (req, res) => {
  const { machineName } = req.query;

  if (!machineName || typeof machineName !== 'string') {
    return res.status(400).json({ error: 'machineName required' });
  }

  // Step 1: Fetch active commands
  const commands = await prisma.controlCommand.findMany({
    where: { machineName, isActive: true },
    select: { id: true, appName: true, action: true, schedule: true }
  });

  // Step 2: Immediately deactivate them (so next poll gets nothing)
  if (commands.length > 0) {
    const ids = commands.map(c => c.id);
    await prisma.controlCommand.updateMany({
      where: { id: { in: ids } },
       data: { isActive: false }
    });
  }

  res.json(commands);
});

// POST /api/commands/ack/:id — Safely deactivate command
// POST /api/commands/ack/:id
app.post('/api/commands/ack/:id', async (req, res) => {
  const { id } = req.params;
  const commandId = parseInt(id, 10);

  if (isNaN(commandId) || commandId <= 0) {
    return res.status(400).json({ error: 'Invalid command ID' });
  }

  try {
    const result = await prisma.controlCommand.updateMany({
      where: {
        id: commandId,
        isActive: true,
      },
      data: { 
        isActive: false,
      },
    });

    if (result.count > 0) {
      console.log(`✅ Acknowledged command ${commandId}`);
    } else {
      console.log(`ℹ️ Command ${commandId} not found or already inactive`);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Ack command error:', error);
    res.status(500).json({ error: 'Failed to acknowledge command' });
  }
});

const PORT = Number(process.env.PORT) || 3001;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`🚀 Backend running on http://${HOST}:${PORT}`);
  console.log(`📁 Routes available at /api/...`);
  console.log(`🔐 Parent secret token: ${PARENT_SECRET}`);
});