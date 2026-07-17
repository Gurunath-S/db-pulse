import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mysql from 'mysql2/promise';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Paths
const DATA_DIR = path.join(__dirname, 'data');
const LINKS_FILE = path.join(DATA_DIR, 'db_links.json');
const LOGS_FILE = path.join(DATA_DIR, 'ping_logs.json');

// Ensure data directory and files exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(LINKS_FILE)) {
  const initialLinks = [];
  if (process.env.DEFAULT_DB_CONNECTION) {
    let service = '';
    let project = '';
    try {
      const url = new URL(process.env.DEFAULT_DB_CONNECTION);
      // Extract service name and project from Aiven host: service-project.c.aivencloud.com
      const hostParts = url.hostname.split('.');
      if (hostParts[0]) {
        const parts = hostParts[0].split('-');
        if (parts.length >= 3) {
          service = `${parts[0]}-${parts[1]}`;
          project = parts.slice(2).join('-');
        }
      }
    } catch (e) {
      console.warn("Failed to parse default db env var host details:", e.message);
    }

    initialLinks.push({
      id: "aiven-default-mysql",
      name: "Aiven Default MySQL",
      connectionString: process.env.DEFAULT_DB_CONNECTION,
      intervalMinutes: 5,
      active: true,
      aivenAutoRecovery: !!process.env.AIVEN_API_TOKEN,
      aivenToken: process.env.AIVEN_API_TOKEN || '',
      aivenProject: project || process.env.AIVEN_PROJECT || '',
      aivenService: service || process.env.AIVEN_SERVICE || ''
    });
  }
  fs.writeFileSync(LINKS_FILE, JSON.stringify(initialLinks, null, 2));
}
if (!fs.existsSync(LOGS_FILE)) {
  fs.writeFileSync(LOGS_FILE, JSON.stringify({}));
}

// Memory stores and active timers
const activeTimers = new Map();
const currentStatuses = new Map(); // Keep track of current runtime status for fast UI access

// Helper functions for reading/writing JSON files
function readJSON(filePath) {
  try {
    const data = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading ${filePath}:`, error);
    return filePath === LINKS_FILE ? [] : {};
  }
}

function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`Error writing ${filePath}:`, error);
  }
}

// Parse connection URL to config options
function parseConnectionString(connectionString) {
  try {
    const url = new URL(connectionString);
    const isSslRequired = url.searchParams.get('ssl-mode') === 'REQUIRED' ||
                          url.searchParams.get('ssl-mode') === 'required' ||
                          url.searchParams.get('ssl') === 'true' ||
                          url.searchParams.get('ssl') === '1' ||
                          connectionString.includes('ssl-mode=REQUIRED') ||
                          connectionString.includes('ssl-mode=required');

    const config = {
      host: url.hostname,
      port: url.port ? parseInt(url.port) : 3306,
      user: url.username,
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ''),
      connectTimeout: 7000,
    };

    if (isSslRequired || url.hostname.includes('aivencloud.com')) {
      config.ssl = {
        rejectUnauthorized: false
      };
    }
    return config;
  } catch (e) {
    // Manual regex fallback parser if URL parsing fails
    const match = connectionString.match(/mysql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/([^?]+)/);
    if (match) {
      return {
        host: match[3],
        port: parseInt(match[4]),
        user: match[1],
        password: decodeURIComponent(match[2]),
        database: match[5],
        connectTimeout: 7000,
        ssl: { rejectUnauthorized: false }
      };
    }
    throw new Error("Invalid MySQL connection string format. Use mysql://user:pass@host:port/db");
  }
}

// Aiven API wake up call
async function wakeUpAivenService(project, service, token) {
  if (!token || !project || !service) {
    return { success: false, error: 'Missing Aiven configurations (token, project, or service)' };
  }
  try {
    const response = await fetch(`https://api.aiven.io/v1/project/${project}/service/${service}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ powered: true })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || `Aiven API returned status ${response.status}`);
    }
    return { success: true, data };
  } catch (error) {
    console.error(`[Aiven recovery failed] ${service}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Fetch Aiven Service status from Aiven API
async function fetchAivenServiceStatus(project, service, token) {
  if (!token || !project || !service) {
    return { success: false, error: 'Missing credentials' };
  }
  try {
    const response = await fetch(`https://api.aiven.io/v1/project/${project}/service/${service}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || `Aiven API status check returned ${response.status}`);
    }
    return { success: true, state: data.service.state, serviceData: data.service };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Perform ping on database connection
async function pingDatabase(link) {
  const start = Date.now();
  let conn = null;
  let status = 'ONLINE';
  let latency = 0;
  let message = 'Connection active';

  try {
    const config = parseConnectionString(link.connectionString);
    conn = await mysql.createConnection(config);
    await conn.query('SELECT 1');
    latency = Date.now() - start;
  } catch (error) {
    latency = Date.now() - start;
    status = 'OFFLINE';
    message = error.message;
    console.warn(`[Ping Failed] Database "${link.name}" is offline:`, message);

    // If Aiven auto-recovery is enabled, attempt to power it on!
    if (link.aivenAutoRecovery && link.aivenToken && link.aivenProject && link.aivenService) {
      status = 'RECOVERING';
      message = 'Offline. Triggered Aiven Auto-Recovery...';
      const recoveryResult = await wakeUpAivenService(link.aivenProject, link.aivenService, link.aivenToken);
      if (recoveryResult.success) {
        message = 'Offline. Aiven Power-On request successfully sent.';
      } else {
        message = `Offline. Aiven Auto-Recovery failed: ${recoveryResult.error}`;
      }
    }
  } finally {
    if (conn) {
      try {
        await conn.end();
      } catch (err) {
        console.error('Error closing connection:', err);
      }
    }
  }

  // Update runtime status cache
  currentStatuses.set(link.id, {
    status,
    latency,
    lastPinged: new Date().toISOString(),
    message
  });

  // Write to ping logs JSON
  const logs = readJSON(LOGS_FILE);
  if (!logs[link.id]) {
    logs[link.id] = [];
  }
  logs[link.id].unshift({
    timestamp: new Date().toISOString(),
    status,
    latency,
    message
  });

  // Limit logs to last 100 entries per link to keep files clean
  if (logs[link.id].length > 100) {
    logs[link.id] = logs[link.id].slice(0, 100);
  }
  writeJSON(LOGS_FILE, logs);

  return { status, latency, message };
}

// Start Scheduler for a database link
function startScheduler(link) {
  // Clear any existing timer first
  if (activeTimers.has(link.id)) {
    clearInterval(activeTimers.get(link.id));
    activeTimers.delete(link.id);
  }

  if (!link.active) return;

  // Run initial ping immediately
  pingDatabase(link);

  // Set interval timer
  const intervalMs = Math.max(1, link.intervalMinutes) * 60 * 1000;
  const timer = setInterval(() => {
    const freshLinks = readJSON(LINKS_FILE);
    const freshLink = freshLinks.find(l => l.id === link.id);
    if (freshLink && freshLink.active) {
      pingDatabase(freshLink);
    } else {
      // If link was deleted or deactivated, clear timer
      clearInterval(timer);
      activeTimers.delete(link.id);
    }
  }, intervalMs);

  activeTimers.set(link.id, timer);
  console.log(`[Scheduler Started] "${link.name}" checking every ${link.intervalMinutes} minutes.`);
}

// Synchronize all active links on boot
function initSchedulers() {
  const links = readJSON(LINKS_FILE);
  links.forEach(link => {
    if (link.active) {
      startScheduler(link);
    } else {
      currentStatuses.set(link.id, {
        status: 'SLEEPING',
        latency: 0,
        lastPinged: null,
        message: 'Monitoring is paused'
      });
    }
  });
}

// REST API Endpoints

// Get all DB links along with their current status
app.get('/api/links', (req, res) => {
  const links = readJSON(LINKS_FILE);
  const linksWithStatus = links.map(link => {
    const statusInfo = currentStatuses.get(link.id) || {
      status: link.active ? 'UNKNOWN' : 'SLEEPING',
      latency: 0,
      lastPinged: null,
      message: link.active ? 'Awaiting first check...' : 'Monitoring is paused'
    };
    return {
      ...link,
      // Strip token from response to keep client secure (send boolean indicator)
      hasToken: !!link.aivenToken,
      aivenToken: undefined, 
      status: statusInfo.status,
      latency: statusInfo.latency,
      lastPinged: statusInfo.lastPinged,
      message: statusInfo.message
    };
  });
  res.json(linksWithStatus);
});

// Add new DB link
app.post('/api/links', async (req, res) => {
  const { name, connectionString, intervalMinutes, active, aivenAutoRecovery, aivenToken, aivenProject, aivenService } = req.body;

  if (!name || !connectionString) {
    return res.status(400).json({ error: 'Name and Connection String are required' });
  }

  try {
    parseConnectionString(connectionString);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const links = readJSON(LINKS_FILE);
  const newLink = {
    id: `db-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    name,
    connectionString,
    intervalMinutes: parseInt(intervalMinutes) || 5,
    active: active !== false,
    aivenAutoRecovery: !!aivenAutoRecovery,
    aivenToken: aivenToken || '',
    aivenProject: aivenProject || '',
    aivenService: aivenService || ''
  };

  links.push(newLink);
  writeJSON(LINKS_FILE, links);

  if (newLink.active) {
    startScheduler(newLink);
  } else {
    currentStatuses.set(newLink.id, {
      status: 'SLEEPING',
      latency: 0,
      lastPinged: null,
      message: 'Monitoring is paused'
    });
  }

  res.status(201).json({ success: true, link: { ...newLink, aivenToken: undefined, hasToken: !!newLink.aivenToken } });
});

// Update existing DB link
app.put('/api/links/:id', (req, res) => {
  const { id } = req.params;
  const { name, connectionString, intervalMinutes, active, aivenAutoRecovery, aivenToken, aivenProject, aivenService } = req.body;

  const links = readJSON(LINKS_FILE);
  const index = links.findIndex(l => l.id === id);

  if (index === -1) {
    return res.status(404).json({ error: 'Database link not found' });
  }

  try {
    if (connectionString) parseConnectionString(connectionString);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const existingLink = links[index];
  
  // Update details (if token is empty string, keep existing token if they didn't send a new one, or delete it)
  // Let's check if they provided a token. If it's a placeholder (like "********"), keep the existing one.
  let finalToken = existingLink.aivenToken;
  if (aivenToken !== undefined) {
    if (aivenToken === '') {
      finalToken = '';
    } else if (aivenToken !== '********') {
      finalToken = aivenToken;
    }
  }

  const updatedLink = {
    ...existingLink,
    name: name !== undefined ? name : existingLink.name,
    connectionString: connectionString !== undefined ? connectionString : existingLink.connectionString,
    intervalMinutes: intervalMinutes !== undefined ? parseInt(intervalMinutes) : existingLink.intervalMinutes,
    active: active !== undefined ? active : existingLink.active,
    aivenAutoRecovery: aivenAutoRecovery !== undefined ? !!aivenAutoRecovery : existingLink.aivenAutoRecovery,
    aivenToken: finalToken,
    aivenProject: aivenProject !== undefined ? aivenProject : existingLink.aivenProject,
    aivenService: aivenService !== undefined ? aivenService : existingLink.aivenService
  };

  links[index] = updatedLink;
  writeJSON(LINKS_FILE, links);

  // Synchronize scheduler timer
  if (updatedLink.active) {
    startScheduler(updatedLink);
  } else {
    if (activeTimers.has(id)) {
      clearInterval(activeTimers.get(id));
      activeTimers.delete(id);
    }
    currentStatuses.set(id, {
      status: 'SLEEPING',
      latency: 0,
      lastPinged: null,
      message: 'Monitoring is paused'
    });
  }

  res.json({ success: true, link: { ...updatedLink, aivenToken: undefined, hasToken: !!updatedLink.aivenToken } });
});

// Delete DB link
app.delete('/api/links/:id', (req, res) => {
  const { id } = req.params;
  const links = readJSON(LINKS_FILE);
  const filtered = links.filter(l => l.id !== id);

  if (links.length === filtered.length) {
    return res.status(404).json({ error: 'Database link not found' });
  }

  writeJSON(LINKS_FILE, filtered);

  if (activeTimers.has(id)) {
    clearInterval(activeTimers.get(id));
    activeTimers.delete(id);
  }
  currentStatuses.delete(id);

  // Clean logs
  const logs = readJSON(LOGS_FILE);
  delete logs[id];
  writeJSON(LOGS_FILE, logs);

  res.json({ success: true });
});

// Manual Ping database on demand
app.post('/api/links/:id/ping', async (req, res) => {
  const { id } = req.params;
  const links = readJSON(LINKS_FILE);
  const link = links.find(l => l.id === id);

  if (!link) {
    return res.status(404).json({ error: 'Database link not found' });
  }

  const result = await pingDatabase(link);
  res.json(result);
});

// Get logs for a specific database link
app.get('/api/logs/:id', (req, res) => {
  const { id } = req.params;
  const logs = readJSON(LOGS_FILE);
  res.json(logs[id] || []);
});

// Manual power on an Aiven service
app.post('/api/aiven/power-on/:id', async (req, res) => {
  const { id } = req.params;
  const { customToken } = req.body; // Allow passing token temporarily from UI or using saved token
  const links = readJSON(LINKS_FILE);
  const link = links.find(l => l.id === id);

  if (!link) {
    return res.status(404).json({ error: 'Database link not found' });
  }

  const token = customToken || link.aivenToken;
  if (!token || !link.aivenProject || !link.aivenService) {
    return res.status(400).json({ error: 'Missing Aiven integration configuration' });
  }

  // Update status to RECOVERING manually
  currentStatuses.set(link.id, {
    status: 'RECOVERING',
    latency: 0,
    lastPinged: new Date().toISOString(),
    message: 'Manual power-on requested. Triggering Aiven API...'
  });

  const result = await wakeUpAivenService(link.aivenProject, link.aivenService, token);
  if (result.success) {
    res.json({ success: true, message: 'Startup command sent to Aiven.' });
  } else {
    res.status(500).json({ error: result.error });
  }
});

// Check Aiven Service Status directly from Aiven Cloud
app.post('/api/aiven/status/:id', async (req, res) => {
  const { id } = req.params;
  const { customToken } = req.body;
  const links = readJSON(LINKS_FILE);
  const link = links.find(l => l.id === id);

  if (!link) {
    return res.status(404).json({ error: 'Database link not found' });
  }

  const token = customToken || link.aivenToken;
  if (!token || !link.aivenProject || !link.aivenService) {
    return res.status(400).json({ error: 'Missing Aiven integration credentials' });
  }

  const result = await fetchAivenServiceStatus(link.aivenProject, link.aivenService, token);
  if (result.success) {
    res.json({ success: true, state: result.state });
  } else {
    res.status(500).json({ error: result.error });
  }
});

// Serve static frontend files in production
const DIST_PATH = path.join(__dirname, 'client', 'dist');
if (fs.existsSync(DIST_PATH)) {
  app.use(express.static(DIST_PATH));
  app.get('*', (req, res) => {
    res.sendFile(path.join(DIST_PATH, 'index.html'));
  });
} else {
  app.get('/', (req, res) => {
    res.send('API Server is running. Front-end not built yet.');
  });
}

// Start server and initialize database schedulers
app.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(` DB-Pulse Server running on http://localhost:${PORT}`);
  console.log(`===============================================`);
  initSchedulers();
});
