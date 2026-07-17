import React, { useState, useEffect, useRef } from 'react';
import { 
  Database, 
  Activity, 
  RefreshCw, 
  Plus, 
  Trash2, 
  Edit3, 
  Settings, 
  Terminal, 
  Play, 
  Power, 
  PowerOff,
  CloudLightning,
  AlertTriangle,
  CheckCircle,
  HelpCircle,
  ExternalLink,
  ChevronRight,
  Shield,
  Clock
} from 'lucide-react';
import './App.css';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3001' : '';

function App() {
  const [links, setLinks] = useState([]);
  const [logs, setLogs] = useState({});
  const [selectedLinkId, setSelectedLinkId] = useState(null);
  
  // Form states
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editId, setEditId] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    connectionString: '',
    intervalMinutes: 5,
    active: true,
    aivenAutoRecovery: false,
    aivenToken: '',
    aivenProject: '',
    aivenService: ''
  });

  // Aiven direct check states
  const [aivenStatus, setAivenStatus] = useState(null);
  const [checkingAiven, setCheckingAiven] = useState(false);
  const [recoveringAiven, setRecoveringAiven] = useState(false);
  
  // App states
  const [filter, setFilter] = useState('ALL'); // ALL, ONLINE, OFFLINE, SLEEPING
  const [globalMessage, setGlobalMessage] = useState(null);
  const logEndRef = useRef(null);

  // Load links and set up auto-refresh
  useEffect(() => {
    fetchLinks();
    const interval = setInterval(fetchLinks, 10000); // refresh links every 10s
    return () => clearInterval(interval);
  }, []);

  // Fetch logs whenever links list updates or when a link is selected
  const fetchLinks = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/links`);
      if (!res.ok) throw new Error("Failed to fetch links");
      const data = await res.json();
      setLinks(data);
      
      // Auto-select first link if none selected
      if (data.length > 0 && !selectedLinkId) {
        setSelectedLinkId(data[0].id);
      }

      // Fetch logs for all links in parallel
      data.forEach(link => {
        fetchLogs(link.id);
      });
    } catch (err) {
      showToast('Error connecting to backend server', 'error');
    }
  };

  const fetchLogs = async (id) => {
    try {
      const res = await fetch(`${API_BASE}/api/logs/${id}`);
      if (res.ok) {
        const data = await res.json();
        setLogs(prev => ({ ...prev, [id]: data }));
      }
    } catch (err) {
      console.error(`Error fetching logs for ${id}:`, err);
    }
  };

  // Toast message utility
  const showToast = (text, type = 'info') => {
    setGlobalMessage({ text, type });
    setTimeout(() => setGlobalMessage(null), 5000);
  };

  // Handle manual ping
  const triggerPing = async (id, e) => {
    if (e) e.stopPropagation();
    showToast('Pinging database...', 'info');
    try {
      const res = await fetch(`${API_BASE}/api/links/${id}/ping`, { method: 'POST' });
      const data = await res.json();
      fetchLinks(); // refresh links status
      if (data.status === 'ONLINE') {
        showToast(`Database is Online! Latency: ${data.latency}ms`, 'success');
      } else {
        showToast(`Database Connection Failed: ${data.message}`, 'error');
      }
    } catch (err) {
      showToast('Ping failed: Backend offline', 'error');
    }
  };

  // Handle active toggle
  const toggleActive = async (link, e) => {
    if (e) e.stopPropagation();
    const newActiveState = !link.active;
    try {
      const res = await fetch(`${API_BASE}/api/links/${link.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: newActiveState })
      });
      if (res.ok) {
        fetchLinks();
        showToast(
          newActiveState ? `Monitoring started for ${link.name}` : `Monitoring paused for ${link.name}`, 
          'info'
        );
      }
    } catch (err) {
      showToast('Toggle failed', 'error');
    }
  };

  // Handle direct Aiven status check
  const checkAivenStatus = async (link) => {
    setCheckingAiven(true);
    setAivenStatus(null);
    try {
      const res = await fetch(`${API_BASE}/api/aiven/status/${link.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (res.ok) {
        setAivenStatus({ state: data.state, error: null });
        showToast(`Aiven Status: ${data.state}`, 'success');
      } else {
        setAivenStatus({ state: null, error: data.error });
        showToast(`Aiven Check Failed: ${data.error}`, 'error');
      }
    } catch (err) {
      setAivenStatus({ state: null, error: 'Network error communicating with API backend' });
      showToast('Status check failed', 'error');
    } finally {
      setCheckingAiven(false);
    }
  };

  // Handle direct Aiven power on request
  const powerOnAiven = async (link) => {
    setRecoveringAiven(true);
    try {
      const res = await fetch(`${API_BASE}/api/aiven/power-on/${link.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const data = await res.json();
      if (res.ok) {
        showToast('Power-on request sent successfully. Database is starting...', 'success');
        fetchLinks();
        // Check state again after 3 seconds
        setTimeout(() => checkAivenStatus(link), 3000);
      } else {
        showToast(`Power-on failed: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast('Power-on request failed', 'error');
    } finally {
      setRecoveringAiven(false);
    }
  };

  // Form handlers
  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const handleEditClick = (link, e) => {
    if (e) e.stopPropagation();
    setIsEditing(true);
    setEditId(link.id);
    setFormData({
      name: link.name,
      connectionString: link.connectionString,
      intervalMinutes: link.intervalMinutes,
      active: link.active,
      aivenAutoRecovery: link.aivenAutoRecovery,
      aivenToken: link.hasToken ? '********' : '', // mask token
      aivenProject: link.aivenProject,
      aivenService: link.aivenService
    });
    setIsFormOpen(true);
    // Scroll to form
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleDeleteClick = async (id, name, e) => {
    if (e) e.stopPropagation();
    if (!window.confirm(`Are you sure you want to delete "${name}"?`)) return;
    
    try {
      const res = await fetch(`${API_BASE}/api/links/${id}`, { method: 'DELETE' });
      if (res.ok) {
        showToast(`Deleted ${name}`, 'info');
        setLinks(prev => prev.filter(l => l.id !== id));
        if (selectedLinkId === id) {
          setSelectedLinkId(null);
        }
      }
    } catch (err) {
      showToast('Delete failed', 'error');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    const url = isEditing 
      ? `${API_BASE}/api/links/${editId}` 
      : `${API_BASE}/api/links`;
      
    const method = isEditing ? 'PUT' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      const data = await res.json();
      
      if (!res.ok) {
        showToast(data.error || 'Operation failed', 'error');
        return;
      }

      showToast(
        isEditing ? 'Connection updated successfully' : 'Connection added successfully', 
        'success'
      );
      
      // Reset form
      setFormData({
        name: '',
        connectionString: '',
        intervalMinutes: 5,
        active: true,
        aivenAutoRecovery: false,
        aivenToken: '',
        aivenProject: '',
        aivenService: ''
      });
      setIsEditing(false);
      setEditId(null);
      setIsFormOpen(false);
      fetchLinks();
    } catch (err) {
      showToast('Operation failed: Server error', 'error');
    }
  };

  const cancelForm = () => {
    setIsEditing(false);
    setEditId(null);
    setFormData({
      name: '',
      connectionString: '',
      intervalMinutes: 5,
      active: true,
      aivenAutoRecovery: false,
      aivenToken: '',
      aivenProject: '',
      aivenService: ''
    });
    setIsFormOpen(false);
  };

  // Sparkline generator
  const renderSparkline = (linkId) => {
    const linkLogs = logs[linkId] || [];
    if (linkLogs.length === 0) {
      return <div className="no-sparkline">Awaiting data...</div>;
    }

    // Get last 15 checks, oldest first
    const recentLogs = [...linkLogs].slice(0, 15).reverse();
    const latencies = recentLogs.map(l => l.status === 'ONLINE' ? l.latency : 0);
    const maxVal = Math.max(...latencies, 20); // Scale ceiling (at least 20ms)
    
    const w = 120;
    const h = 32;
    const padding = 2;

    const points = latencies.map((val, idx) => {
      const x = padding + (idx / (latencies.length - 1 || 1)) * (w - padding * 2);
      const y = (h - padding) - (val / maxVal) * (h - padding * 2);
      return { x, y };
    });

    const linePath = points.map(p => `${p.x},${p.y}`).join(' L ');
    const areaPath = points.length > 0 
      ? `M ${points[0].x},${h} L ${linePath} L ${points[points.length - 1].x},${h} Z`
      : '';

    const latestStatus = linkLogs[0]?.status;
    const isOnline = latestStatus === 'ONLINE';
    const isRecovering = latestStatus === 'RECOVERING';
    const strokeColor = isOnline ? '#10b981' : isRecovering ? '#f59e0b' : '#ef4444';

    return (
      <svg width={w} height={h} className="sparkline-svg">
        <defs>
          <linearGradient id={`grad-${linkId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity="0.25"/>
            <stop offset="100%" stopColor={strokeColor} stopOpacity="0.00"/>
          </linearGradient>
        </defs>
        {points.length > 1 && (
          <>
            <path d={areaPath} fill={`url(#grad-${linkId})`} />
            <path d={`M ${linePath}`} fill="none" stroke={strokeColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx={points[points.length - 1].x} cy={points[points.length - 1].y} r="3.5" fill={strokeColor} className="ping-dot" />
          </>
        )}
      </svg>
    );
  };

  const getStatusBadgeClass = (status) => {
    switch (status) {
      case 'ONLINE': return 'badge-online';
      case 'OFFLINE': return 'badge-offline';
      case 'RECOVERING': return 'badge-recovering';
      case 'SLEEPING': return 'badge-sleeping';
      default: return 'badge-unknown';
    }
  };

  // Filtering links
  const filteredLinks = links.filter(link => {
    if (filter === 'ALL') return true;
    return link.status === filter;
  });

  const selectedLink = links.find(l => l.id === selectedLinkId);
  const selectedLogs = logs[selectedLinkId] || [];

  // Summary counts
  const onlineCount = links.filter(l => l.status === 'ONLINE').length;
  const offlineCount = links.filter(l => l.status === 'OFFLINE' || l.status === 'RECOVERING').length;
  const sleepingCount = links.filter(l => l.status === 'SLEEPING').length;

  return (
    <div className="app-container">
      {/* Background elements */}
      <div className="glow-bg">
        <div className="glow-sphere color-primary"></div>
        <div className="glow-sphere color-secondary"></div>
      </div>

      {/* Global Toast */}
      {globalMessage && (
        <div className={`toast-notification toast-${globalMessage.type}`}>
          {globalMessage.type === 'success' && <CheckCircle size={18} />}
          {globalMessage.type === 'error' && <AlertTriangle size={18} />}
          <span>{globalMessage.text}</span>
        </div>
      )}

      {/* Header */}
      <header className="app-header">
        <div className="brand">
          <div className="brand-logo">
            <Activity className="heartbeat-icon" size={24} />
          </div>
          <div>
            <h1>DB-Pulse</h1>
            <p className="subtitle">Database Keep-Alive & Monitoring System</p>
          </div>
        </div>

        {/* Global Stats */}
        <div className="global-stats">
          <div className="stat-pill online" onClick={() => setFilter('ONLINE')}>
            <span className="dot online-dot"></span>
            <span className="stat-label">Online</span>
            <span className="stat-count">{onlineCount}</span>
          </div>
          <div className="stat-pill offline" onClick={() => setFilter('OFFLINE')}>
            <span className="dot offline-dot"></span>
            <span className="stat-label">Offline</span>
            <span className="stat-count">{offlineCount}</span>
          </div>
          <div className="stat-pill sleeping" onClick={() => setFilter('SLEEPING')}>
            <span className="dot sleeping-dot"></span>
            <span className="stat-label">Paused</span>
            <span className="stat-count">{sleepingCount}</span>
          </div>
          <button 
            className="btn btn-primary add-db-btn"
            onClick={() => {
              cancelForm();
              setIsFormOpen(true);
            }}
          >
            <Plus size={16} />
            <span>Add Connection</span>
          </button>
        </div>
      </header>

      <main className="dashboard-content">
        
        {/* Connection Form Block */}
        {isFormOpen && (
          <section className="form-card glass-panel animate-slide-down">
            <div className="card-header">
              <div className="header-title">
                <Database size={18} className="accent-color" />
                <h2>{isEditing ? 'Modify Connection Details' : 'Add Database Connection'}</h2>
              </div>
              <button className="btn-close" onClick={cancelForm}>×</button>
            </div>
            
            <form onSubmit={handleSubmit} className="connection-form">
              <div className="form-row">
                <div className="form-group flex-1">
                  <label>Connection Name</label>
                  <input
                    type="text"
                    name="name"
                    value={formData.name}
                    onChange={handleInputChange}
                    placeholder="e.g. Production MySQL, Client Read Replica"
                    required
                  />
                </div>
                <div className="form-group flex-1">
                  <label>Ping Interval</label>
                  <div className="select-wrapper">
                    <select
                      name="intervalMinutes"
                      value={formData.intervalMinutes}
                      onChange={handleInputChange}
                    >
                      <option value={1}>Every 1 Minute (High Frequency)</option>
                      <option value={2}>Every 2 Minutes</option>
                      <option value={5}>Every 5 Minutes (Recommended)</option>
                      <option value={10}>Every 10 Minutes</option>
                      <option value={30}>Every 30 Minutes</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="form-group">
                <label>Database Connection String (MySQL URI)</label>
                <input
                  type="text"
                  name="connectionString"
                  value={formData.connectionString}
                  onChange={handleInputChange}
                  placeholder="mysql://user:password@host:port/database?ssl-mode=REQUIRED"
                  required
                />
                <small className="help-text">
                  URLs containing <code>ssl-mode=REQUIRED</code> will connect securely. Note: credentials remain stored locally.
                </small>
              </div>

              <div className="checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    name="active"
                    checked={formData.active}
                    onChange={handleInputChange}
                  />
                  <span className="checkbox-custom"></span>
                  <span className="checkbox-text">Enable Active Heartbeat Pings on startup</span>
                </label>
              </div>

              {/* Aiven Cloud Integration Sub-Form */}
              <div className="aiven-integration-block">
                <div className="aiven-header">
                  <CloudLightning size={18} className="aiven-accent" />
                  <h3>Aiven Cloud Recovery (Optional)</h3>
                  <label className="switch">
                    <input
                      type="checkbox"
                      name="aivenAutoRecovery"
                      checked={formData.aivenAutoRecovery}
                      onChange={handleInputChange}
                    />
                    <span className="slider round"></span>
                  </label>
                </div>
                <p className="aiven-desc">
                  If your Aiven DB powers down due to inactivity, DB-Pulse can query the Aiven API and automatically boot the instance back online.
                </p>

                {formData.aivenAutoRecovery && (
                  <div className="aiven-fields animate-fade-in">
                    <div className="form-group">
                      <label>Aiven API Token</label>
                      <input
                        type="password"
                        name="aivenToken"
                        value={formData.aivenToken}
                        onChange={handleInputChange}
                        placeholder={isEditing && formData.aivenToken === '********' ? '••••••••' : 'Aiven Auth Token'}
                        required={formData.aivenAutoRecovery}
                      />
                      <small className="help-text">Generated from Aiven Console &rarr; User Profile &rarr; Tokens.</small>
                    </div>
                    <div className="form-row">
                      <div className="form-group flex-1">
                        <label>Aiven Project Name</label>
                        <input
                          type="text"
                          name="aivenProject"
                          value={formData.aivenProject}
                          onChange={handleInputChange}
                          placeholder="e.g. guruthedev1-a254"
                          required={formData.aivenAutoRecovery}
                        />
                      </div>
                      <div className="form-group flex-1">
                        <label>Aiven Service Name</label>
                        <input
                          type="text"
                          name="aivenService"
                          value={formData.aivenService}
                          onChange={handleInputChange}
                          placeholder="e.g. mysql-15c533a1"
                          required={formData.aivenAutoRecovery}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={cancelForm}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {isEditing ? 'Save Changes' : 'Create Keep-Alive'}
                </button>
              </div>
            </form>
          </section>
        )}

        <div className="grid-layout">
          
          {/* Left Column: DB List */}
          <section className="list-column">
            <div className="section-header">
              <h2>Monitored Links</h2>
              <div className="filter-tabs">
                <button 
                  className={`tab-btn ${filter === 'ALL' ? 'active' : ''}`}
                  onClick={() => setFilter('ALL')}
                >
                  All ({links.length})
                </button>
                <button 
                  className={`tab-btn ${filter === 'ONLINE' ? 'active' : ''}`}
                  onClick={() => setFilter('ONLINE')}
                >
                  Online ({onlineCount})
                </button>
                <button 
                  className={`tab-btn ${filter === 'OFFLINE' ? 'active' : ''}`}
                  onClick={() => setFilter('OFFLINE')}
                >
                  Offline ({offlineCount})
                </button>
              </div>
            </div>

            <div className="links-list">
              {filteredLinks.length === 0 ? (
                <div className="empty-state glass-panel">
                  <Database size={40} className="empty-icon" />
                  <p>No databases match the filter.</p>
                  {!isFormOpen && (
                    <button className="btn btn-secondary mt-2" onClick={() => setIsFormOpen(true)}>
                      Add a Connection
                    </button>
                  )}
                </div>
              ) : (
                filteredLinks.map(link => {
                  const isSelected = link.id === selectedLinkId;
                  
                  // Extract display host name
                  let displayHost = 'Unknown Host';
                  try {
                    const hostPart = link.connectionString.split('@')[1];
                    if (hostPart) {
                      displayHost = hostPart.split('/')[0].split(':')[0];
                    }
                  } catch (e) {}

                  return (
                    <div 
                      key={link.id}
                      className={`link-card glass-panel ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedLinkId(link.id)}
                    >
                      <div className="link-card-body">
                        <div className="link-info-row">
                          <div className="link-icon-container">
                            <Database size={20} className="db-icon" />
                            <span className={`status-glow ${link.status.toLowerCase()}`}></span>
                          </div>
                          <div className="link-meta">
                            <h3 className="link-name">{link.name}</h3>
                            <span className="link-host">{displayHost}</span>
                          </div>
                          <div className="link-status">
                            <span className={`badge ${getStatusBadgeClass(link.status)}`}>
                              {link.status}
                            </span>
                          </div>
                        </div>

                        <div className="link-metrics-row">
                          <div className="metric-box">
                            <span className="metric-label">Latency</span>
                            <span className="metric-value">
                              {link.status === 'ONLINE' ? `${link.latency}ms` : '--'}
                            </span>
                          </div>
                          
                          <div className="metric-box flex-grow">
                            <span className="metric-label">Heartbeat History (10s refresh)</span>
                            <div className="sparkline-container">
                              {renderSparkline(link.id)}
                            </div>
                          </div>
                        </div>

                        <div className="link-actions-row">
                          <div className="interval-indicator">
                            <Clock size={12} />
                            <span>Every {link.intervalMinutes}m</span>
                            {link.aivenAutoRecovery && (
                              <span className="aiven-badge" title="Aiven Auto-Recovery Active">
                                <CloudLightning size={10} />
                                Aiven
                              </span>
                            )}
                          </div>

                          <div className="action-buttons">
                            <button 
                              className="action-btn btn-ping"
                              title="Force immediate check"
                              onClick={(e) => triggerPing(link.id, e)}
                            >
                              <Play size={12} />
                            </button>
                            <button 
                              className={`action-btn btn-power ${link.active ? 'active' : ''}`}
                              title={link.active ? "Pause Monitoring" : "Resume Monitoring"}
                              onClick={(e) => toggleActive(link, e)}
                            >
                              {link.active ? <Power size={12} /> : <PowerOff size={12} />}
                            </button>
                            <button 
                              className="action-btn btn-edit"
                              title="Edit Configuration"
                              onClick={(e) => handleEditClick(link, e)}
                            >
                              <Edit3 size={12} />
                            </button>
                            <button 
                              className="action-btn btn-delete"
                              title="Delete Link"
                              onClick={(e) => handleDeleteClick(link.id, link.name, e)}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>

          {/* Right Column: Console Logs & Connection Detail */}
          <section className="detail-column">
            {selectedLink ? (
              <div className="detail-wrapper">
                
                {/* Connection Health Overview */}
                <div className="detail-card glass-panel">
                  <div className="detail-header">
                    <h2>Connection Details</h2>
                    <span className={`badge ${getStatusBadgeClass(selectedLink.status)}`}>
                      {selectedLink.status}
                    </span>
                  </div>

                  <div className="detail-info-grid">
                    <div className="info-item">
                      <span className="info-label">Display Name</span>
                      <span className="info-value">{selectedLink.name}</span>
                    </div>
                    <div className="info-item">
                      <span className="info-label">Ping Interval</span>
                      <span className="info-value">Runs every {selectedLink.intervalMinutes} minute(s)</span>
                    </div>
                    <div className="info-item full-width">
                      <span className="info-label">MySQL Connection URL (Credentials Masked)</span>
                      <span className="info-value code-font">
                        {selectedLink.connectionString.replace(/:([^@:]+)@/, ':••••••••@')}
                      </span>
                    </div>
                  </div>

                  {/* Aiven Status controls */}
                  {selectedLink.aivenAutoRecovery && (
                    <div className="aiven-controls-box">
                      <div className="box-title">
                        <CloudLightning size={16} />
                        <h4>Aiven Cloud Status & Manual Actions</h4>
                      </div>
                      
                      <div className="aiven-status-fields">
                        <div><strong>Project:</strong> {selectedLink.aivenProject}</div>
                        <div><strong>Service:</strong> {selectedLink.aivenService}</div>
                      </div>

                      {aivenStatus && (
                        <div className={`aiven-status-report ${aivenStatus.error ? 'report-error' : 'report-ok'}`}>
                          {aivenStatus.error ? (
                            <p><strong>Error checking Aiven Console:</strong> {aivenStatus.error}</p>
                          ) : (
                            <p>
                              Aiven Console State: <span className="state-tag">{aivenStatus.state}</span>
                              {aivenStatus.state === 'POWEROFF' && ' (Database is suspended!)'}
                              {aivenStatus.state === 'RUNNING' && ' (Database is active!)'}
                            </p>
                          )}
                        </div>
                      )}

                      <div className="aiven-buttons">
                        <button 
                          className="btn btn-secondary btn-sm"
                          onClick={() => checkAivenStatus(selectedLink)}
                          disabled={checkingAiven}
                        >
                          {checkingAiven ? <RefreshCw className="spin-icon" size={12} /> : <RefreshCw size={12} />}
                          Check Cloud State
                        </button>
                        <button 
                          className="btn btn-primary btn-sm btn-aiven-wake"
                          onClick={() => powerOnAiven(selectedLink)}
                          disabled={recoveringAiven}
                        >
                          <CloudLightning size={12} />
                          Force Power On DB
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Console Log Terminal */}
                <div className="terminal-card glass-panel">
                  <div className="terminal-header">
                    <div className="header-left">
                      <Terminal size={16} />
                      <h3>Diagnostic Stream: {selectedLink.name}</h3>
                    </div>
                    <button 
                      className="btn-refresh-logs"
                      onClick={() => fetchLogs(selectedLink.id)}
                      title="Reload logs"
                    >
                      <RefreshCw size={12} />
                    </button>
                  </div>
                  
                  <div className="terminal-body">
                    {selectedLogs.length === 0 ? (
                      <div className="terminal-empty">Awaiting ping events...</div>
                    ) : (
                      selectedLogs.map((log, index) => {
                        const dateStr = new Date(log.timestamp).toLocaleTimeString();
                        let statusColor = 'text-info';
                        if (log.status === 'ONLINE') statusColor = 'text-success';
                        if (log.status === 'OFFLINE') statusColor = 'text-danger';
                        if (log.status === 'RECOVERING') statusColor = 'text-warning';

                        return (
                          <div key={index} className="log-line">
                            <span className="log-time">[{dateStr}]</span>
                            <span className={`log-badge ${statusColor}`}>{log.status}</span>
                            <span className="log-latency">({log.latency}ms)</span>
                            <span className="log-msg">&rarr; {log.message}</span>
                          </div>
                        );
                      })
                    )}
                    <div ref={logEndRef}></div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="empty-detail-state glass-panel">
                <Database size={48} className="accent-color opacity-30" />
                <h3>Select a Database Connection</h3>
                <p>Click on one of the database cards on the left to see detailed ping reports, connection metrics, and diagnostic logs.</p>
              </div>
            )}
          </section>

        </div>
      </main>

      <footer className="app-footer">
        <p>DB-Pulse Database Keep-Alive Daemon &bull; Running Locally &bull; Secure Storage</p>
      </footer>
    </div>
  );
}

export default App;
