chrome.runtime.onMessageExternal.addListener(
  (request, sender, sendResponse) => {
    if (request.action === 'fetch_html' && request.url) {
      console.log('Received request to extract via network:', request.url);
      
      let capturedPayloads = [];
      let contentScriptActive = false;

      // Listen for messages from the content script relay
      const messageListener = (msg, senderProxy) => {
        if (msg.type === "CAPTURED_CHAT_DATA" && senderProxy.tab?.id === tabId) {
           capturedPayloads.push(msg.payload);
        }
      };
      chrome.runtime.onMessage.addListener(messageListener);

      let tabId = null;

      chrome.tabs.create({ url: request.url, active: false }, (tab) => {
        tabId = tab.id;
        
        let injected = false;
        
        // We need to inject AS SOON as the page starts navigating to the target
        const onUpdatedListener = (uTabId, changeInfo, uTab) => {
          if (uTabId === tabId && changeInfo.status === 'loading' && !injected) {
            injected = true;
            
            // Inject the MAIN world interceptor
            chrome.scripting.executeScript({
              target: { tabId: tabId },
              world: "MAIN",
              injectImmediately: true,
              func: () => {
                (function () {
                  function send(payload) {
                    window.postMessage({ type: "AI_CHAT_CAPTURE", payload }, "*");
                  }

                  // Hook fetch
                  const origFetch = window.fetch;
                  window.fetch = async (...args) => {
                    const res = await origFetch(...args);
                    try {
                      const clone = res.clone();
                      clone.text().then(text => {
                        if (text && (text.includes("message") || text.includes("content"))) {
                          send(text);
                        }
                      });
                    } catch (e) {}
                    return res;
                  };

                  // Hook XHR
                  const origOpen = XMLHttpRequest.prototype.open;
                  XMLHttpRequest.prototype.open = function () {
                    this.addEventListener("load", function () {
                      try {
                        const text = this.responseText;
                        if (text && (text.includes("message") || text.includes("content"))) {
                          send(text);
                        }
                      } catch (e) {}
                    });
                    origOpen.apply(this, arguments);
                  };
                })();
              }
            }).catch(e => console.error("Interceptor inject error", e));

            // Inject the ISOLATED world relay script
            chrome.scripting.executeScript({
              target: { tabId: tabId },
              world: "ISOLATED",
              injectImmediately: true,
              func: () => {
                window.addEventListener("message", (event) => {
                  if (event.data?.type === "AI_CHAT_CAPTURE") {
                    chrome.runtime.sendMessage({
                      type: "CAPTURED_CHAT_DATA",
                      payload: event.data.payload
                    });
                  }
                });
              }
            }).catch(e => console.error("Relay inject error", e));
          }
        };

        chrome.tabs.onUpdated.addListener(onUpdatedListener);

        // Wait a fixed amount of time for network payloads to settle
        // 8 seconds should be enough for the initial network requests
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(onUpdatedListener);
          chrome.runtime.onMessage.removeListener(messageListener);
          
          chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => document.documentElement.outerHTML
          }).then((results) => {
            chrome.tabs.remove(tabId);
            
            let finalHtml = "";
            if (results && results[0] && results[0].result) {
               finalHtml = results[0].result;
            }

            // Parse the captured payloads
            const messages = parseJSONNetworkPayloads(capturedPayloads);

            console.log("Extracted messages via network:", messages);

            if (messages.length > 0) {
               sendResponse({ html: JSON.stringify(messages), success: true });
            } else {
               // fallback to returning the large payload (outerHTML) to let the server parse the DOM
               sendResponse({ html: finalHtml, success: true });
            }
          }).catch(e => {
            // fallback if script injection fails
            chrome.tabs.remove(tabId);
            sendResponse({ html: "", success: false });
          });
        }, 8000);
      });
      
      return true;
    }
  }
);

function extractPossibleJSONs(text) {
  let jsons = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let startIdx = -1;
  
  for (let i = 0; i < text.length; i++) {
    let char = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;
    } else {
      if (char === '"') inString = true;
      else if (char === '{') {
        if (depth === 0) startIdx = i;
        depth++;
      } else if (char === '}') {
        if (depth > 0) {
          depth--;
          if (depth === 0 && startIdx !== -1) {
            jsons.push(text.substring(startIdx, i + 1));
            startIdx = -1;
          }
        }
      }
    }
  }
  return jsons;
}

function parseJSONNetworkPayloads(payloads) {
  let mappedMessages = [];
  
  function traverse(obj) {
    if (!obj || typeof obj !== 'object') return;
    
    // Check if it looks like a message
    let roleCandidate = obj.role || obj.author?.role || obj.message?.author?.role;
    let contentCandidate = obj.content || obj.text || obj.message?.content?.parts;
    let idCandidate = obj.id || obj.message?.id || obj.nodeId;

    if (roleCandidate && contentCandidate) {
       let role = String(roleCandidate).toLowerCase();
       if (role === 'human' || role === 'user') role = 'user';
       else if (role === 'assistant' || role === 'model' || role === 'ai') role = 'assistant';
       else role = 'system';
       
       let content = '';
       if (typeof contentCandidate === 'string') {
         content = contentCandidate;
       } else if (Array.isArray(contentCandidate)) {
         content = contentCandidate.map(p => typeof p === 'string' ? p : p.text || '').join('\\n');
       } else if (typeof contentCandidate === 'object' && contentCandidate.parts) {
         if (Array.isArray(contentCandidate.parts)) content = contentCandidate.parts.join('\\n');
       }

       if (content.trim()) {
         mappedMessages.push({
           id: idCandidate || Math.random().toString(),
           role: role,
           content: content
         });
       }
    }

    for (let key in obj) {
       if (obj.hasOwnProperty(key)) {
          traverse(obj[key]);
       }
    }
  }

  for (let text of payloads) {
    if (typeof text !== 'string') continue;
    
    // SSE streaming extraction (data: {})
    if (text.includes('data: {')) {
       let lines = text.split('\\n');
       for (let line of lines) {
         if (line.startsWith('data: ')) {
           try {
             traverse(JSON.parse(line.slice(6)));
           } catch(e) {}
         }
       }
    } else {
       try {
         traverse(JSON.parse(text));
       } catch(e) {
          let chunks = extractPossibleJSONs(text);
          for (let c of chunks) {
             try { traverse(JSON.parse(c)); } catch(e2) {}
          }
       }
    }
  }

  // Deduplicate. SSE can cause many identical or growing messages.
  // We map by ID if possible, otherwise by exact content.
  // Actually, with streaming, the LAST seen message for an ID is the most complete.
  let uniqueMap = new Map();
  for (let m of mappedMessages) {
    let key = m.id || m.content;
    uniqueMap.set(key, m);
  }

  // If ids were generated randomly because no id existed, we might have dupes. Filter out by content as well.
  let contentMap = new Map();
  for (let m of Array.from(uniqueMap.values())) {
    contentMap.set(m.content, m);
  }

  let finalMessages = Array.from(contentMap.values());
  
  // Clean up format
  return finalMessages.map(m => ({
     role: m.role,
     content: m.content
  })).filter(m => m.role !== 'system');
}
