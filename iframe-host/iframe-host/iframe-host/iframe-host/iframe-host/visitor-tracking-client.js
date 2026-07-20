/**
 * Client-side Visitor Tracking Script
 *
 * Collects device fingerprint, screen info, and tracks user behavior
 * Send data to /api/track endpoint
 */

(function() {
  'use strict';

  const API_ENDPOINT = '/api/track';
  let visitorId = null;
  let sessionStart = Date.now();
  let lastActivity = Date.now();
  let pageViewStart = Date.now();
  let interactionCount = 0;

  // ========== Device Fingerprinting ==========

  /**
   * Generate Canvas fingerprint
   */
  function getCanvasFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = 200;
      canvas.height = 50;

      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('Hello, visitor! 🎨', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('Fingerprint', 4, 17);

      return canvas.toDataURL();
    } catch (e) {
      return null;
    }
  }

  /**
   * Generate WebGL fingerprint
   */
  function getWebGLFingerprint() {
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return null;

      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (!debugInfo) return null;

      return {
        vendor: gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
        renderer: gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL),
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Hash function for fingerprinting
   */
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Collect device information
   */
  function collectDeviceInfo() {
    const canvas = getCanvasFingerprint();
    const webgl = getWebGLFingerprint();

    const components = [
      navigator.userAgent,
      navigator.language,
      screen.width + 'x' + screen.height,
      screen.colorDepth,
      new Date().getTimezoneOffset(),
      !!window.sessionStorage,
      !!window.localStorage,
      canvas || '',
      JSON.stringify(webgl || {}),
    ];

    const fingerprint = simpleHash(components.join('|'));

    return {
      fingerprint,
      screen_width: screen.width,
      screen_height: screen.height,
      screen_color_depth: screen.colorDepth,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezone_offset: new Date().getTimezoneOffset(),
      language: navigator.language,
      languages: navigator.languages ? navigator.languages.join(',') : '',
      platform: navigator.platform,
      hardware_concurrency: navigator.hardwareConcurrency || null,
      device_memory: navigator.deviceMemory || null,
      cookie_enabled: navigator.cookieEnabled,
      do_not_track: navigator.doNotTrack,
      canvas_fingerprint: canvas ? simpleHash(canvas) : null,
      webgl_vendor: webgl ? webgl.vendor : null,
      webgl_renderer: webgl ? webgl.renderer : null,
    };
  }

  // ========== Event Tracking ==========

  /**
   * Send tracking data to server
   */
  function sendEvent(type, data = {}) {
    const payload = {
      type,
      page: window.location.pathname,
      timestamp: Date.now(),
      data,
    };

    // Use sendBeacon for reliability (fires even when page unloads)
    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon(API_ENDPOINT, blob);
    } else {
      // Fallback to fetch
      fetch(API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {}); // Ignore errors
    }
  }

  /**
   * Initialize tracking
   */
  function initTracking() {
    const deviceInfo = collectDeviceInfo();

    // Send initial pageview with device info
    sendEvent('pageview', {
      ...deviceInfo,
      referrer: document.referrer,
      title: document.title,
    });

    // Track time on page
    setInterval(() => {
      const timeSpent = Date.now() - pageViewStart;
      if (timeSpent > 1000) { // Only track if spent more than 1 second
        sendEvent('time_spent', {
          duration: timeSpent,
          active_time: Date.now() - lastActivity < 30000, // Active if activity in last 30s
        });
        pageViewStart = Date.now(); // Reset for next interval
      }
    }, 10000); // Send every 10 seconds

    // Track interactions
    let scrollDepth = 0;
    window.addEventListener('scroll', throttle(() => {
      const depth = Math.round((window.scrollY + window.innerHeight) / document.body.scrollHeight * 100);
      if (depth > scrollDepth) {
        scrollDepth = depth;
        sendEvent('scroll', { depth, max_depth: scrollDepth });
        interactionCount++;
        lastActivity = Date.now();
      }
    }, 1000));

    // Track clicks
    document.addEventListener('click', (e) => {
      const target = e.target;
      const tagName = target.tagName.toLowerCase();
      const data = {
        tag: tagName,
        id: target.id || null,
        class: target.className || null,
        text: target.innerText ? target.innerText.substring(0, 50) : null,
      };

      // Only track meaningful clicks
      if (['a', 'button', 'input', 'select'].includes(tagName) || target.onclick) {
        sendEvent('click', data);
        interactionCount++;
        lastActivity = Date.now();
      }
    });

    // Track form submissions
    document.addEventListener('submit', (e) => {
      const form = e.target;
      sendEvent('form_submit', {
        action: form.action || null,
        method: form.method || null,
        id: form.id || null,
      });
      interactionCount++;
      lastActivity = Date.now();
    });

    // Track page visibility
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        sendEvent('blur', { time_visible: Date.now() - lastActivity });
      } else {
        sendEvent('focus', {});
        lastActivity = Date.now();
      }
    });

    // Track page unload (session end)
    window.addEventListener('beforeunload', () => {
      const sessionDuration = Date.now() - sessionStart;
      sendEvent('session_end', {
        duration: sessionDuration,
        interactions: interactionCount,
      });
    });

    // Track mouse movement (for bot detection)
    let mouseMoveCount = 0;
    document.addEventListener('mousemove', throttle(() => {
      mouseMoveCount++;
      if (mouseMoveCount === 1) {
        sendEvent('first_mouse_move', { timestamp: Date.now() - sessionStart });
      }
      lastActivity = Date.now();
    }, 5000));
  }

  /**
   * Throttle function
   */
  function throttle(func, delay) {
    let lastCall = 0;
    return function(...args) {
      const now = Date.now();
      if (now - lastCall >= delay) {
        lastCall = now;
        return func(...args);
      }
    };
  }

  // ========== Initialize ==========

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTracking);
  } else {
    initTracking();
  }

})();
