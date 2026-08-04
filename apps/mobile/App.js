import React, { useState, useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
  ActivityIndicator,
  Alert,
} from 'react-native';

const GATEWAY_URL = 'http://localhost:3000'; // Fallback gateway URL

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [tenantId, setTenantId] = useState('tenant-nova-business');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);

  const [selectedTab, setSelectedTab] = useState('chats'); // 'chats' | 'analytics'
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [replyText, setReplyText] = useState('');

  const [analytics, setAnalytics] = useState(null);

  // Auto-load mockup sessions if backend not responsive
  const mockSessions = [
    { id: 'telegram-tenant-123-chat456', channel: 'telegram', lastMsg: 'I need pricing help', time: '2m ago', activeTakeover: true },
    { id: 'whatsapp-tenant-123-num789', channel: 'whatsapp', lastMsg: 'Is the bot online?', time: '10m ago', activeTakeover: false },
    { id: 'instagram-tenant-123-ig888', channel: 'instagram', lastMsg: 'Do you ship to New York?', time: '30s ago', activeTakeover: true },
  ];

  const mockAnalytics = {
    salesTrends: { today: { revenue: 249.00, count: 3 } },
    visitors: { totalVisits: 142, uniqueVisitors: 55, bounceRate: 22, avgSessionLength: 310 },
    products: [{ productId: 'nova-personal', views: 80, conversions: 2, conversionRate: 2.5 }]
  };

  useEffect(() => {
    if (isLoggedIn) {
      fetchData();
      const interval = setInterval(fetchData, 8000);
      return () => clearInterval(interval);
    }
  }, [isLoggedIn]);

  const fetchData = async () => {
    try {
      // 1. Fetch sessions/stats
      const statsRes = await fetch(`${GATEWAY_URL}/api/widget/stats`);
      if (statsRes.ok) {
        const data = await statsRes.json();
        // Format sessions from visitor logs
        const formatted = (data.leads || []).map(l => ({
          id: l.sessionId,
          channel: l.sessionId.split('-')[0] || 'widget',
          lastMsg: `${l.name} (${l.email})`,
          time: 'Active',
          activeTakeover: true,
        }));
        setSessions(formatted.length > 0 ? formatted : mockSessions);
      } else {
        setSessions(mockSessions);
      }

      // 2. Fetch Analytics
      const analRes = await fetch(`${GATEWAY_URL}/api/analytics/overview`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (analRes.ok) {
        const data = await analRes.json();
        setAnalytics(data);
      } else {
        setAnalytics(mockAnalytics);
      }
    } catch (e) {
      console.warn('[NOVA Mobile] Failed to load dashboard data, showing sample data:', e);
      setSessions(mockSessions);
      setAnalytics(mockAnalytics);
    }
  };

  const handleLogin = async () => {
    if (!password) {
      Alert.alert('Error', 'Please enter your dashboard access code');
      return;
    }
    setLoading(true);

    try {
      // Generate client-side token or verify with backend
      // Using mock auth token logic for stand-alone mobile shell
      const mockToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoib3duZXIiLCJlbWFpbCI6Im93bmVyQG5vdmEuYWkiLCJleHAiOjE4MDc0MjQwMDB9.mockSignature';
      setToken(mockToken);
      setIsLoggedIn(true);

      // Register device FCM token
      await fetch(`${GATEWAY_URL}/api/notifications/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId, token: 'mobile-fcm-token-sandbox-123' })
      }).catch((err) => {
        console.warn('[NOVA Mobile] Push notification registration failed:', err);
      });

    } catch (err) {
      Alert.alert('Login Failed', err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleStartTakeover = async (sessionId) => {
    try {
      await fetch(`${GATEWAY_URL}/api/takeover/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, tenantId })
      });
      Alert.alert('Takeover Activated', `Manual override active for ${sessionId}`);
      fetchData();
    } catch (e) {
      // Offline fallback toggle
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, activeTakeover: true } : s));
    }
  };

  const handleStopTakeover = async (sessionId) => {
    try {
      await fetch(`${GATEWAY_URL}/api/takeover/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      Alert.alert('Takeover Deactivated', 'AI assistant is now handling responses.');
      fetchData();
    } catch (e) {
      setSessions(prev => prev.map(s => s.id === sessionId ? { ...s, activeTakeover: false } : s));
    }
  };

  const handleSendOverride = async () => {
    if (!replyText.trim()) return;
    try {
      await fetch(`${GATEWAY_URL}/api/takeover/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: selectedSessionId, message: replyText })
      });
      setChatMessages(prev => [...prev, { role: 'assistant', content: replyText }]);
      setReplyText('');
    } catch (e) {
      setChatMessages(prev => [...prev, { role: 'assistant', content: replyText }]);
      setReplyText('');
    }
  };

  const selectSession = (session) => {
    setSelectedSessionId(session.id);
    // Mock history load
    setChatMessages([
      { role: 'user', content: session.lastMsg || 'Hello, I need help.' },
      { role: 'assistant', content: 'Sure, I am the NOVA AI assistant. What can I do for you?' }
    ]);
  };

  if (!isLoggedIn) {
    return (
      <SafeAreaView style={styles.loginContainer}>
        <StatusBar style="light" />
        <View style={styles.loginCard}>
          <Text style={styles.logoText}>NOVA</Text>
          <Text style={styles.tagline}>Mobile Control Plane</Text>
          
          <Text style={styles.label}>Tenant ID</Text>
          <TextInput
            style={styles.input}
            value={tenantId}
            onChangeText={setTenantId}
            placeholder="tenant-nova-business"
            placeholderTextColor="#94a3b8"
          />

          <Text style={styles.label}>Owner Security Key</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="••••••••"
            placeholderTextColor="#94a3b8"
          />

          <TouchableOpacity style={styles.button} onPress={handleLogin} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Authenticate Console</Text>}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>NOVA Live Console</Text>
        <Text style={styles.headerTenant}>{tenantId}</Text>
      </View>

      {/* Navigation tabs */}
      <View style={styles.tabContainer}>
        <TouchableOpacity
          style={[styles.tabButton, selectedTab === 'chats' && styles.activeTabButton]}
          onPress={() => { setSelectedTab('chats'); setSelectedSessionId(null); }}
        >
          <Text style={[styles.tabText, selectedTab === 'chats' && styles.activeTabText]}>Active Takeovers</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabButton, selectedTab === 'analytics' && styles.activeTabButton]}
          onPress={() => setSelectedTab('analytics')}
        >
          <Text style={[styles.tabText, selectedTab === 'analytics' && styles.activeTabText]}>Business Analytics</Text>
        </TouchableOpacity>
      </View>

      {/* Main View */}
      {selectedTab === 'chats' ? (
        selectedSessionId ? (
          // Individual chat override view
          <View style={styles.chatWrapper}>
            <TouchableOpacity style={styles.backButton} onPress={() => setSelectedSessionId(null)}>
              <Text style={styles.backButtonText}>← Back to Takeovers</Text>
            </TouchableOpacity>
            
            <View style={styles.chatSessionHeader}>
              <Text style={styles.chatSessionTitle}>{selectedSessionId}</Text>
              <TouchableOpacity
                style={styles.stopTakeoverButton}
                onPress={() => handleStopTakeover(selectedSessionId)}
              >
                <Text style={styles.stopTakeoverButtonText}>Release AI</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.chatHistory}>
              {chatMessages.map((msg, i) => (
                <View key={i} style={[styles.msgBubble, msg.role === 'user' ? styles.userMsg : styles.agentMsg]}>
                  <Text style={styles.msgRole}>{msg.role.toUpperCase()}</Text>
                  <Text style={styles.msgText}>{msg.content}</Text>
                </View>
              ))}
            </ScrollView>

            <View style={styles.replyArea}>
              <TextInput
                style={styles.replyInput}
                value={replyText}
                onChangeText={setReplyText}
                placeholder="Send override message..."
                placeholderTextColor="#94a3b8"
              />
              <TouchableOpacity style={styles.sendButton} onPress={handleSendOverride}>
                <Text style={styles.sendButtonText}>Send</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          // Chats listing
          <ScrollView style={styles.scrollList}>
            {sessions.map(s => (
              <View key={s.id} style={styles.sessionCard}>
                <View style={styles.sessionCardHeader}>
                  <Text style={styles.sessionChannel}>[{s.channel.toUpperCase()}]</Text>
                  <Text style={styles.sessionTime}>{s.time}</Text>
                </View>
                <Text style={styles.sessionTitle}>{s.id}</Text>
                <Text style={styles.sessionLast}>{s.lastMsg}</Text>
                
                <View style={styles.sessionActions}>
                  {s.activeTakeover ? (
                    <TouchableOpacity style={styles.chatButton} onPress={() => selectSession(s)}>
                      <Text style={styles.chatButtonText}>Enter Override Chat</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity style={styles.takeoverButton} onPress={() => handleStartTakeover(s.id)}>
                      <Text style={styles.takeoverButtonText}>Takeover Control</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            ))}
          </ScrollView>
        )
      ) : (
        // Analytics overview
        <ScrollView style={styles.scrollList}>
          {analytics ? (
            <View style={styles.analyticsWrapper}>
              <Text style={styles.sectionHeader}>Sales Revenue trends</Text>
              <View style={styles.metricRow}>
                <View style={styles.metricBox}>
                  <Text style={styles.metricLabel}>Today's Sales</Text>
                  <Text style={styles.metricValue}>${analytics.salesTrends.today.revenue.toFixed(2)}</Text>
                  <Text style={styles.metricSub}>{analytics.salesTrends.today.count} transactions</Text>
                </View>
              </View>

              <Text style={styles.sectionHeader}>Traffic & Visitor analytics</Text>
              <View style={styles.grid}>
                <View style={styles.gridBox}>
                  <Text style={styles.metricLabel}>Unique Visitors</Text>
                  <Text style={styles.metricValue}>{analytics.visitors.uniqueVisitors}</Text>
                </View>
                <View style={styles.gridBox}>
                  <Text style={styles.metricLabel}>Bounce Rate</Text>
                  <Text style={styles.metricValue}>{analytics.visitors.bounceRate}%</Text>
                </View>
                <View style={styles.gridBox}>
                  <Text style={styles.metricLabel}>Avg. Session Length</Text>
                  <Text style={styles.metricValue}>{analytics.visitors.avgSessionLength}s</Text>
                </View>
              </View>

              <Text style={styles.sectionHeader}>Product performance rankings</Text>
              {analytics.products.map(p => (
                <View key={p.productId} style={styles.productCard}>
                  <Text style={styles.productTitle}>Product: {p.productId}</Text>
                  <View style={styles.productMeta}>
                    <Text style={styles.productLabel}>Views: {p.views}</Text>
                    <Text style={styles.productLabel}>Sales: {p.conversions}</Text>
                    <Text style={styles.productLabel}>Conversion Rate: {p.conversionRate}%</Text>
                  </View>
                </View>
              ))}
            </View>
          ) : (
            <ActivityIndicator style={{ marginTop: 50 }} color="#a855f7" />
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0c1b',
  },
  loginContainer: {
    flex: 1,
    backgroundColor: '#090514',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loginCard: {
    width: '90%',
    padding: 30,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  logoText: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#fff',
    textAlign: 'center',
    letterSpacing: 2,
  },
  tagline: {
    fontSize: 14,
    color: '#a855f7',
    textAlign: 'center',
    marginBottom: 30,
    textTransform: 'uppercase',
  },
  label: {
    color: '#94a3b8',
    fontSize: 13,
    marginBottom: 8,
    textTransform: 'uppercase',
  },
  input: {
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    color: '#fff',
    fontSize: 16,
    marginBottom: 20,
  },
  button: {
    backgroundColor: '#a855f7',
    padding: 15,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 10,
  },
  buttonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 16,
  },
  header: {
    padding: 20,
    backgroundColor: '#16122c',
    borderBottomWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#fff',
  },
  headerTenant: {
    fontSize: 12,
    color: '#a855f7',
    marginTop: 2,
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#16122c',
  },
  tabButton: {
    flex: 1,
    padding: 15,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderColor: 'transparent',
  },
  activeTabButton: {
    borderColor: '#a855f7',
  },
  tabText: {
    color: '#94a3b8',
    fontWeight: '600',
  },
  activeTabText: {
    color: '#fff',
  },
  scrollList: {
    flex: 1,
    padding: 15,
  },
  sessionCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
    padding: 15,
    marginBottom: 15,
  },
  sessionCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sessionChannel: {
    color: '#a855f7',
    fontWeight: 'bold',
    fontSize: 12,
  },
  sessionTime: {
    color: '#64748b',
    fontSize: 12,
  },
  sessionTitle: {
    fontSize: 16,
    color: '#fff',
    fontWeight: 'bold',
  },
  sessionLast: {
    color: '#94a3b8',
    marginTop: 5,
    fontSize: 14,
  },
  sessionActions: {
    marginTop: 15,
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  takeoverButton: {
    backgroundColor: '#3b82f6',
    paddingVertical: 8,
    paddingHorizontal: 15,
    borderRadius: 6,
  },
  takeoverButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 13,
  },
  chatButton: {
    backgroundColor: '#a855f7',
    paddingVertical: 8,
    paddingHorizontal: 15,
    borderRadius: 6,
  },
  chatButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 13,
  },
  chatWrapper: {
    flex: 1,
    padding: 15,
  },
  backButton: {
    marginBottom: 15,
  },
  backButtonText: {
    color: '#a855f7',
    fontWeight: '600',
  },
  chatSessionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 15,
  },
  chatSessionTitle: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
    width: '70%',
  },
  stopTakeoverButton: {
    backgroundColor: '#ef4444',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  stopTakeoverButtonText: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 12,
  },
  chatHistory: {
    flex: 1,
    marginBottom: 15,
  },
  msgBubble: {
    padding: 12,
    borderRadius: 8,
    marginBottom: 10,
    maxWidth: '85%',
  },
  userMsg: {
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.2)',
    alignSelf: 'flex-start',
  },
  agentMsg: {
    backgroundColor: 'rgba(168, 85, 247, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(168, 85, 247, 0.2)',
    alignSelf: 'flex-end',
  },
  msgRole: {
    fontSize: 10,
    fontWeight: 'bold',
    color: '#64748b',
    marginBottom: 4,
  },
  msgText: {
    color: '#fff',
    fontSize: 14,
  },
  replyArea: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  replyInput: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    color: '#fff',
    marginRight: 10,
  },
  sendButton: {
    backgroundColor: '#a855f7',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  sendButtonText: {
    color: '#fff',
    fontWeight: 'bold',
  },
  analyticsWrapper: {
    paddingBottom: 30,
  },
  sectionHeader: {
    fontSize: 16,
    color: '#a855f7',
    fontWeight: 'bold',
    textTransform: 'uppercase',
    marginTop: 20,
    marginBottom: 10,
  },
  metricRow: {
    flexDirection: 'row',
    marginBottom: 15,
  },
  metricBox: {
    flex: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 12,
    padding: 20,
  },
  metricLabel: {
    color: '#94a3b8',
    fontSize: 13,
    textTransform: 'uppercase',
  },
  metricValue: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#fff',
    marginTop: 5,
  },
  metricSub: {
    color: '#64748b',
    fontSize: 12,
    marginTop: 5,
  },
  grid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 15,
  },
  gridBox: {
    width: '31%',
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 10,
    padding: 12,
  },
  productCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 10,
    padding: 15,
    marginBottom: 10,
  },
  productTitle: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 14,
  },
  productMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  productLabel: {
    color: '#94a3b8',
    fontSize: 12,
  },
});
