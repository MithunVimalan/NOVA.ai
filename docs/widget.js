(function () {
  // CONFIGURATION & SETUP
  const API_HOST = window.NOVA_API_HOST || 'http://localhost:3000';
  const STORAGE_KEY = 'nova_engage_session_id';
  
  // 1. Generate or restore persistent session ID
  let sessionId = localStorage.getItem(STORAGE_KEY);
  if (!sessionId) {
    sessionId = 'sess-' + Math.random().toString(36).substring(2, 15) + '-' + Date.now();
    localStorage.setItem(STORAGE_KEY, sessionId);
  }

  // 2. Track Return Visitor
  let returnVisits = parseInt(localStorage.getItem('nova_return_visits') || '0', 10);
  const sessionHasTrackedThisTurn = sessionStorage.getItem('nova_tracked_this_turn');
  if (!sessionHasTrackedThisTurn) {
    returnVisits += 1;
    localStorage.setItem('nova_return_visits', returnVisits.toString());
    sessionStorage.setItem('nova_tracked_this_turn', 'true');
  }

  // INJECT STYLES
  const style = document.createElement('style');
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600&display=swap');
    
    #nova-widget-container {
      font-family: 'Outfit', sans-serif;
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
    }

    #nova-widget-trigger {
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: linear-gradient(135deg, #a855f7 0%, #3b82f6 100%);
      box-shadow: 0 8px 30px rgba(168, 85, 247, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    #nova-widget-trigger:hover {
      transform: scale(1.1) rotate(5deg);
      box-shadow: 0 12px 35px rgba(168, 85, 247, 0.6);
    }

    #nova-widget-trigger svg {
      width: 28px;
      height: 28px;
      fill: #fff;
      transition: transform 0.3s ease;
    }

    #nova-widget-window {
      width: 380px;
      height: 580px;
      border-radius: 24px;
      background: rgba(15, 12, 27, 0.85);
      backdrop-filter: blur(20px);
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
      margin-bottom: 15px;
      display: none;
      flex-direction: column;
      overflow: hidden;
      transform: translateY(20px);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }

    #nova-widget-window.open {
      display: flex;
      transform: translateY(0);
      opacity: 1;
    }

    .nova-header {
      background: linear-gradient(135deg, rgba(168, 85, 247, 0.2) 0%, rgba(59, 130, 246, 0.2) 100%);
      padding: 20px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .nova-avatar {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: linear-gradient(135deg, #a855f7 0%, #3b82f6 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      color: #fff;
      font-size: 1.2rem;
      border: 2px solid rgba(255, 255, 255, 0.2);
    }

    .nova-title-box {
      flex: 1;
    }

    .nova-title {
      font-weight: 600;
      color: #fff;
      font-size: 1.1rem;
      margin: 0;
      letter-spacing: 0.5px;
    }

    .nova-status {
      font-size: 0.8rem;
      color: #10b981;
      display: flex;
      align-items: center;
      gap: 5px;
      margin-top: 2px;
    }

    .nova-status::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
    }

    .nova-messages {
      flex: 1;
      padding: 20px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 15px;
    }

    .nova-msg {
      max-width: 80%;
      padding: 12px 16px;
      border-radius: 18px;
      font-size: 0.95rem;
      line-height: 1.45;
      animation: msgFadeIn 0.3s ease forwards;
    }

    .nova-msg.assistant {
      background: rgba(255, 255, 255, 0.05);
      color: #e2e8f0;
      align-self: flex-start;
      border-bottom-left-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .nova-msg.user {
      background: linear-gradient(135deg, #a855f7 0%, #7c3aed 100%);
      color: #fff;
      align-self: flex-end;
      border-bottom-right-radius: 4px;
    }

    .nova-footer {
      padding: 15px;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      gap: 10px;
      align-items: center;
      background: rgba(10, 8, 18, 0.5);
    }

    .nova-input {
      flex: 1;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 12px 16px;
      color: #fff;
      outline: none;
      font-size: 0.95rem;
      transition: border 0.3s ease;
    }

    .nova-input:focus {
      border-color: #a855f7;
    }

    .nova-send-btn {
      background: #a855f7;
      border: none;
      color: #fff;
      padding: 12px;
      border-radius: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.3s ease;
    }

    .nova-send-btn:hover {
      background: #7c3aed;
    }

    .nova-send-btn svg {
      width: 18px;
      height: 18px;
      fill: #fff;
    }

    .nova-lead-form {
      margin-top: 10px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.06);
      padding: 15px;
      border-radius: 14px;
    }

    .nova-lead-form input {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      padding: 8px 12px;
      color: #fff;
      font-size: 0.9rem;
      outline: none;
    }

    .nova-lead-form button {
      background: #3b82f6;
      border: none;
      color: #fff;
      padding: 8px;
      border-radius: 8px;
      font-weight: 500;
      cursor: pointer;
      font-size: 0.9rem;
      transition: background 0.2s ease;
    }

    .nova-lead-form button:hover {
      background: #2563eb;
    }

    @keyframes msgFadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);

  // CREATE WIDGET DOM
  const container = document.createElement('div');
  container.id = 'nova-widget-container';
  container.innerHTML = `
    <div id="nova-widget-window">
      <div class="nova-header">
        <div class="nova-avatar">N</div>
        <div class="nova-title-box">
          <p class="nova-title">NOVA Engage</p>
          <span class="nova-status">Online</span>
        </div>
      </div>
      <div class="nova-messages" id="nova-messages-list">
        <div class="nova-msg assistant">Hello! I am NOVA. How can I help you today? Let me know if you have questions about our plans or product features.</div>
      </div>
      <div class="nova-footer">
        <input type="text" class="nova-input" id="nova-chat-input" placeholder="Type a message..." autocomplete="off" />
        <button class="nova-send-btn" id="nova-send-message">
          <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
        </button>
      </div>
    </div>
    <div id="nova-widget-trigger">
      <svg viewBox="0 0 24 24" id="nova-trigger-icon">
        <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>
      </svg>
    </div>
  `;
  document.body.appendChild(container);

  // WIDGET DOM REFERENCES
  const trigger = document.getElementById('nova-widget-trigger');
  const triggerIcon = document.getElementById('nova-trigger-icon');
  const chatWindow = document.getElementById('nova-widget-window');
  const chatInput = document.getElementById('nova-chat-input') as HTMLInputElement;
  const sendBtn = document.getElementById('nova-send-message');
  const messagesList = document.getElementById('nova-messages-list');

  // STATE VARIABLES
  let isWindowOpen = false;
  let hasTriggeredProactive = false;
  let pageStartTime = Date.now();

  // TOGGLE WIDGET WINDOW
  function toggleWindow() {
    isWindowOpen = !isWindowOpen;
    if (isWindowOpen) {
      chatWindow.style.display = 'flex';
      // Force repaint to trigger animation
      chatWindow.offsetHeight;
      chatWindow.classList.add('open');
      triggerIcon.innerHTML = `<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>`;
      chatInput.focus();
    } else {
      chatWindow.classList.remove('open');
      triggerIcon.innerHTML = `<path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/>`;
      setTimeout(() => {
        if (!isWindowOpen) chatWindow.style.display = 'none';
      }, 300);
    }
  }

  trigger.addEventListener('click', toggleWindow);

  // ADD MESSAGE TO SCREEN
  function appendMessage(sender: 'user' | 'assistant', text: string) {
    const msg = document.createElement('div');
    msg.className = `nova-msg ${sender}`;
    msg.innerHTML = text;
    messagesList.appendChild(msg);
    messagesList.scrollTop = messagesList.scrollHeight;
  }

  // LEAD CAPTURE FORM INJECTOR
  function checkAndInjectLeadForm(text: string) {
    if (text.toLowerCase().includes('email') || text.toLowerCase().includes('sign up') || text.toLowerCase().includes('contact')) {
      if (document.getElementById('nova-lead-form-container')) return;

      const formContainer = document.createElement('div');
      formContainer.id = 'nova-lead-form-container';
      formContainer.className = 'nova-lead-form';
      formContainer.innerHTML = `
        <p style="margin:0 0 5px 0; font-size:0.85rem; color:#94a3b8; font-weight:500;">Secure your priority trial slot:</p>
        <input type="text" id="nova-lead-name" placeholder="Your Name" />
        <input type="email" id="nova-lead-email" placeholder="Your Email" />
        <button id="nova-lead-submit">Submit Details</button>
      `;
      messagesList.appendChild(formContainer);
      messagesList.scrollTop = messagesList.scrollHeight;

      document.getElementById('nova-lead-submit').addEventListener('click', () => {
        const nameVal = (document.getElementById('nova-lead-name') as HTMLInputElement).value.trim();
        const emailVal = (document.getElementById('nova-lead-email') as HTMLInputElement).value.trim();
        
        if (nameVal && emailVal) {
          fetch(`${API_HOST}/api/widget/lead`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, name: nameVal, email: emailVal })
          }).then(() => {
            formContainer.innerHTML = `<p style="margin:0; color:#10b981; font-size:0.9rem; font-weight:600; text-align:center;">✓ Details captured! Thank you.</p>`;
            setTimeout(() => formContainer.remove(), 3000);
          });
        }
      });
    }
  }

  // SEND MESSAGE HANDLER
  async function sendMessage() {
    const val = chatInput.value.trim();
    if (!val) return;

    appendMessage('user', val);
    chatInput.value = '';

    const typingMsg = document.createElement('div');
    typingMsg.className = 'nova-msg assistant';
    typingMsg.textContent = 'NOVA is typing...';
    messagesList.appendChild(typingMsg);
    messagesList.scrollTop = messagesList.scrollHeight;

    try {
      const response = await fetch(`${API_HOST}/api/widget/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: val, sessionId })
      });

      typingMsg.remove();
      
      if (response.ok) {
        const data = await response.json();
        appendMessage('assistant', data.reply);
        checkAndInjectLeadForm(data.reply);
      } else {
        appendMessage('assistant', 'Sorry, I encountered an error. Please try again.');
      }
    } catch (err) {
      typingMsg.remove();
      appendMessage('assistant', 'Unable to connect to local NOVA server. Verify it is running.');
    }
  }

  sendBtn.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendMessage();
  });

  // BEHAVIORAL TRACKING HOOKS
  function trackEvent(customData = {}) {
    const scrollMax = document.documentElement.scrollHeight - window.innerHeight;
    const scrollDepth = scrollMax > 0 ? Math.round((window.scrollY / scrollMax) * 100) : 0;
    const timeOnPage = Math.round((Date.now() - pageStartTime) / 1000);

    fetch(`${API_HOST}/api/widget/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        pageUrl: window.location.href,
        referrer: document.referrer,
        scrollDepth,
        timeOnPage,
        ...customData
      })
    }).catch(() => {});
  }

  trackEvent();
  setInterval(trackEvent, 15000);

  // RULE 1: Time on page trigger
  setTimeout(() => {
    if (!isWindowOpen && !hasTriggeredProactive) {
      hasTriggeredProactive = true;
      toggleWindow();
      appendMessage('assistant', `Hi! 🚀 I noticed you've been reviewing this page for a while. Let me know if you need details on the $7/mo subscription plan or local setup!`);
      trackEvent({ proactiveTrigger: 'time_on_page' });
    }
  }, 45000);

  // RULE 2: Return visitor personalized greeting
  if (returnVisits > 1 && !hasTriggeredProactive) {
    setTimeout(() => {
      if (!isWindowOpen) {
        toggleWindow();
        appendMessage('assistant', `Welcome back! 👋 Nice to see you again. Ready to finalize your local NOVA assistant deployment?`);
        hasTriggeredProactive = true;
        trackEvent({ proactiveTrigger: 'return_visitor' });
      }
    }, 5000);
  }

  // RULE 3: Exit Intent Detection
  document.addEventListener('mouseleave', (e) => {
    if (e.clientY < 20 && !hasTriggeredProactive) {
      hasTriggeredProactive = true;
      if (!isWindowOpen) toggleWindow();
      appendMessage('assistant', `🎁 Wait! Don't leave empty-handed! Claim your first month of **NOVA Pro** for only $4 (use code <b>LOCALPOWER</b>). Can I assist you further?`);
      trackEvent({ proactiveTrigger: 'exit_intent' });
    }
  });

})();
