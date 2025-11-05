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
      screenTime = false // default to false for backward compatibility
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
        screenTime // <-- new field
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
        durationSeconds: true,
        screenTime: true,
      },
    });

    const appMap: Record<string, { focused: number; screen: number }> = {};

    for (const log of logs) {
  const app = log.appName || 'unknown';
  if (!appMap[app]) {
    appMap[app] = { focused: 0, screen: 0 };
  }

  const duration = log.durationSeconds ?? 0; // ✅ Safely handle null

  if (log.screenTime) {
    appMap[app].screen += duration;
  } else {
    appMap[app].focused += duration;
  }
}

    const result = Object.entries(appMap).map(([app, times]) => ({
      app,
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
app.get('/api/screen-time/total', async (req, res) => {
  try {
    const { start, end } = getDateRange(req.query.date as string | undefined);

    const screenTimeTotal = await prisma.activityLog.aggregate({
      _sum: {
        durationSeconds: true,
      },
      where: {
        screenTime: true,
        timestamp: { gte: start, lt: end },
        // ✅ Remove null filter — _sum ignores nulls automatically
      },
    });

    const focusedTimeTotal = await prisma.activityLog.aggregate({
      _sum: {
        durationSeconds: true,
      },
      where: {
        screenTime: false,
        timestamp: { gte: start, lt: end },
      },
    });

    // ✅ Use optional chaining (already correct)
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

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';
/*app.listen(PORT, HOST, () => {
  console.log(`🚀 Backend running on http://${HOST}:${PORT}`);
  console.log(`🔐 Secret token: ${PARENT_SECRET}`);
});*/
app.listen(3001, HOST, () => {
  console.log(`🚀 Backend running on http://${HOST}:${3001}`);
  console.log(`🔐 Secret token: ${PARENT_SECRET}`);
});