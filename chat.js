(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const client = window.supabase?.createClient("https://mvfnycefnmpwtuoajliq.supabase.co", "sb_publishable_-_KnKaBRJLvTl2VLfNWTXA_FFpZvqcr");
  let user = null, peer = null, generation = 0, searching = 0, searchTimer, polling = false, sending = false;
  let messages = new Map(), drafts = new Map(), retries = new Map(), conversations = [];
  const compare = (a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0;
  const ordered = () => [...messages.values()].sort(compare);
  const status = (message) => { $("chatStatus").textContent = message; $("chatStatus").hidden = !message; };
  const errorText = (error) => /schema cache|does not exist/i.test(error?.message || "") ? "Chat is being set up. Please refresh in a moment." : error?.message || "Couldn't connect. Please try again.";
  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data;
  }
  function renderPeople(target, people, inbox = false) {
    const fragment = document.createDocumentFragment();
    for (const person of people) {
      const id = person.peer_id || person.user_id;
      const button = document.createElement("button");
      button.type = "button"; button.className = "person";
      button.dataset.initials = (person.display_name || person.email || "User").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
      button.setAttribute("aria-current", String(peer?.id === id));
      const name = document.createElement("strong"); name.textContent = person.display_name || person.email;
      if (Number(person.unread_count)) {
        const count = document.createElement("span"); count.className = "count"; count.textContent = person.unread_count; count.setAttribute("aria-label", `${person.unread_count} unread messages`); name.append(count);
      }
      const detail = document.createElement("small"); detail.textContent = inbox ? person.last_body : person.email;
      button.append(name, detail);
      button.addEventListener("click", () => openConversation({ id, name: person.display_name, email: person.email }));
      fragment.append(button);
    }
    target.replaceChildren(fragment);
    if (inbox && !people.length) {
      const empty = document.createElement("p"); empty.className = "hint"; empty.textContent = "No conversations yet. Find a user above to say hello."; target.append(empty);
    }
  }
  async function loadInbox() {
    const epoch = generation, userId = user?.id;
    const data = await rpc("list_direct_conversations");
    if (!userId || user?.id !== userId || epoch !== generation) return;
    conversations = data || []; renderPeople($("conversations"), conversations, true);
    const unread = conversations.reduce((sum, conversation) => sum + Number(conversation.unread_count), 0);
    $("unreadTotal").textContent = unread; $("unreadTotal").hidden = !unread;
    document.title = `${unread ? `(${unread}) ` : ""}Chat — EFFICIENT SIGN`;
  }
  function renderMessages(scrollToEnd = false) {
    const scroll = $("messageScroll"), nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90;
    const fragment = document.createDocumentFragment();
    for (const message of ordered()) {
      const item = document.createElement("li"); item.className = "message" + (message.sender_id === user?.id ? " mine" : "");
      const body = document.createElement("p"); body.textContent = message.body;
      const time = document.createElement("time"); time.dateTime = message.created_at;
      time.textContent = `${message.sender_id === user?.id ? "You" : peer.name || peer.email} · ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(message.created_at))}`;
      item.append(body, time); fragment.append(item);
    }
    $("messages").replaceChildren(fragment); $("emptyMessages").hidden = messages.size > 0;
    if (scrollToEnd || nearBottom) scroll.scrollTop = scroll.scrollHeight;
  }
  async function readLoaded(epoch, activePeer) {
    if (document.hidden || epoch !== generation || peer?.id !== activePeer) return;
    const incoming = ordered().filter((message) => message.sender_id !== user.id && !message.read_at);
    if (!incoming.length) return;
    await rpc("mark_direct_messages_read", { p_peer_id: activePeer, p_through: incoming.at(-1).id });
    if (epoch === generation) for (const message of incoming) message.read_at = new Date().toISOString();
  }
  async function openConversation(person) {
    if (!user || peer?.id === person.id) return;
    if (peer) drafts.set(peer.id, $("messageBody").value);
    peer = person; generation++; const epoch = generation;
    messages = new Map();
    $("noConversation").hidden = true; $("conversationPanel").hidden = false;
    $("peerName").textContent = person.name || person.email; $("peerEmail").textContent = person.email;
    $("messageBody").value = drafts.get(person.id) || ""; updateComposer();
    $("messages").replaceChildren(); $("emptyMessages").hidden = true; $("loadOlder").hidden = true;
    $("conversationStatus").textContent = "Loading messages…";
    renderPeople($("conversations"), conversations, true);
    try {
      const data = await rpc("get_direct_messages", { p_peer_id: person.id });
      if (epoch !== generation) return;
      for (const message of data || []) messages.set(message.id, message);
      $("loadOlder").hidden = (data || []).length < 50;
      renderMessages(true); $("conversationStatus").textContent = "";
      await readLoaded(epoch, person.id); await loadInbox();
    } catch (error) { if (epoch === generation) $("conversationStatus").textContent = errorText(error); }
  }
  function updateComposer() {
    $("messageCount").textContent = $("messageBody").value.length;
    $("sendMessage").disabled = !peer || sending || !$("messageBody").value.trim();
    $("sendMessage").textContent = sending ? "Sending…" : "Send message";
  }
  async function poll() {
    if (!user || polling || document.hidden) return;
    polling = true; const epoch = generation, activePeer = peer?.id;
    try {
      if (activePeer) {
        // Fetch forward by ID, retaining loaded history and catching up after reconnects.
        for (let batch = 0; batch < 5; batch++) {
          const last = ordered().at(-1)?.id;
          const data = await rpc("get_direct_messages", { p_peer_id: activePeer, ...(last ? { p_after: last } : {}) });
          if (epoch !== generation || peer?.id !== activePeer) return;
          for (const message of data || []) messages.set(message.id, message);
          if ((data || []).length) renderMessages();
          if (!last || (data || []).length < 100) break;
        }
        await readLoaded(epoch, activePeer);
        if (epoch === generation) $("conversationStatus").textContent = "";
      }
      await loadInbox(); if (epoch === generation) status("");
    } catch (error) { if (epoch === generation) status(errorText(error)); }
    finally { polling = false; }
  }
  $("userSearch").addEventListener("input", () => {
    clearTimeout(searchTimer); const query = $("userSearch").value.trim(), sequence = ++searching, userId = user?.id;
    $("searchResults").replaceChildren();
    $("searchStatus").textContent = query.length < 2 ? "Type at least two characters." : "Searching…";
    if (query.length < 2 || !userId) return;
    searchTimer = setTimeout(async () => {
      try {
        const data = await rpc("search_signing_users", { p_query: query });
        if (sequence !== searching || user?.id !== userId) return;
        renderPeople($("searchResults"), data || []);
        $("searchStatus").textContent = data?.length ? "Select a user to chat." : "No users found.";
      } catch (error) { if (sequence === searching && user?.id === userId) $("searchStatus").textContent = errorText(error); }
    }, 300);
  });
  $("messageBody").addEventListener("input", () => { if (peer) drafts.set(peer.id, $("messageBody").value); updateComposer(); });
  $("messageBody").addEventListener("keydown", (event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); $("messageForm").requestSubmit(); } });
  $("messageForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = $("messageBody").value.trim(), recipient = peer?.id, userId = user?.id, epoch = generation;
    if (!body || body.length > 2000 || sending || !recipient || !userId) return;
    const previous = retries.get(recipient);
    const id = previous?.body === body ? previous.id : crypto.randomUUID();
    retries.set(recipient, { body, id }); sending = true; updateComposer(); $("conversationStatus").textContent = "";
    try {
      await rpc("send_direct_message", { p_recipient_id: recipient, p_body: body, p_client_message_id: id });
      if (user?.id !== userId) return;
      retries.delete(recipient);
      if ((drafts.get(recipient) || "").trim() === body) drafts.delete(recipient);
      if (epoch === generation && $("messageBody").value.trim() === body) $("messageBody").value = "";
      await poll();
      if (epoch === generation) renderMessages(true);
    } catch (error) { if (epoch === generation) $("conversationStatus").textContent = errorText(error) + " Your message is kept here; try sending again."; }
    finally { sending = false; updateComposer(); }
  });
  $("loadOlder").addEventListener("click", async () => {
    if (!peer || !messages.size) return;
    const epoch = generation, activePeer = peer.id, scroll = $("messageScroll"), height = scroll.scrollHeight;
    $("loadOlder").disabled = true;
    try {
      const data = await rpc("get_direct_messages", { p_peer_id: activePeer, p_before: ordered()[0].id });
      if (epoch !== generation) return;
      for (const message of data || []) messages.set(message.id, message);
      $("loadOlder").hidden = (data || []).length < 50; renderMessages(); scroll.scrollTop += scroll.scrollHeight - height;
      await readLoaded(epoch, activePeer);
    } catch (error) { if (epoch === generation) $("conversationStatus").textContent = errorText(error); }
    finally { $("loadOlder").disabled = false; }
  });
  function setUser(nextUser) {
    if (user?.id === nextUser?.id) return;
    user = nextUser; generation++; searching++;
    peer = null; messages = new Map(); drafts = new Map(); retries = new Map(); conversations = [];
    $("userSearch").value = ""; $("searchResults").replaceChildren(); $("messages").replaceChildren(); $("messageBody").value = "";
    $("searchStatus").textContent = "Type at least two characters.";
    $("noConversation").hidden = false; $("conversationPanel").hidden = true;
    $("chatLayout").hidden = !user; $("signIn").hidden = Boolean(user); $("signOut").hidden = !user;
    $("accountName").textContent = user?.email || "";
    document.title = "Chat — EFFICIENT SIGN";
    status(user ? "Loading conversations…" : "Sign in to chat with other users.");
    if (user) void poll();
  }
  $("signOut").addEventListener("click", async () => {
    const { error } = await client.auth.signOut();
    if (error) status(errorText(error)); else setUser(null);
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void poll(); });
  window.addEventListener("online", () => void poll());
  setInterval(() => void poll(), 5000);
  if (!client) { status("Chat tools couldn't load. Check your connection and refresh."); $("signIn").hidden = false; return; }
  // Defer network work outside Supabase's synchronous auth callback.
  client.auth.onAuthStateChange((_event, session) => setTimeout(() => setUser(session?.user || null), 0));
  client.auth.getSession().then(({ data, error }) => {
    if (error) { status(errorText(error)); $("signIn").hidden = false; }
    else if (data.session?.user) setUser(data.session.user);
    else { $("signIn").hidden = false; status("Sign in to chat with other users."); }
  }).catch((error) => status(errorText(error)));
})();
