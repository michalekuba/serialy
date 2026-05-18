const mainContent = document.getElementById('mainContent');

const APP_BASE_URL = new URL('.', window.location.href);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v']);
const SERIALS_ROOT_CANDIDATES = Array.from(new Set([
  new URL('files/', APP_BASE_URL).pathname,
  '/files/',
  APP_BASE_URL.pathname
]));
const INDEX_CACHE_KEY = 'serialyIndexV1';

let shows = [];
let activeEpisodePath = null;
let expandedShows = new Set();
let serialsRootPath = SERIALS_ROOT_CANDIDATES[0];
let flatEpisodes = [];
let activeEpisodeIndex = -1;

function clearElement(element) {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

function loadIndexCache() {
  try {
    const raw = sessionStorage.getItem(INDEX_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.shows)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveIndexCache() {
  try {
    const payload = {
      serialsRootPath,
      shows,
      flatEpisodes
    };
    sessionStorage.setItem(INDEX_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore
  }
}

function getDisplayNameFromPath(pathname) {
  const trimmed = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const segment = trimmed.split('/').filter(Boolean).pop() || '';
  return decodeURIComponent(segment);
}

function getFileExtension(name) {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function getFileNameWithoutExtension(name) {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(0, index) : name;
}

function sortByName(a, b) {
  return a.name.localeCompare(b.name, 'cs');
}

function normalizeDirectoryPath(pathname) {
  if (!pathname.endsWith('/')) {
    return `${pathname}/`;
  }
  return pathname;
}

async function fetchDirectoryEntries(pathname) {
  const normalizedDirectory = normalizeDirectoryPath(pathname);
  const response = await fetch(normalizedDirectory, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: {
      Accept: 'text/html'
    }
  });

  if (!response.ok) {
    throw new Error(`Nepodařilo se načíst složku ${normalizedDirectory}`);
  }

  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const anchors = Array.from(doc.querySelectorAll('a[href]'));

  const entries = [];
  const seen = new Set();

  anchors.forEach((anchor) => {
    const rawHref = anchor.getAttribute('href');

    if (!rawHref || rawHref === '../' || rawHref.startsWith('#') || rawHref.startsWith('?')) {
      return;
    }

    let url;
    try {
      url = new URL(rawHref, window.location.origin + normalizedDirectory);
    } catch {
      return;
    }

    if (url.origin !== window.location.origin) {
      return;
    }

    const normalizedPath = url.pathname;
    if (!normalizedPath.startsWith(normalizedDirectory)) {
      return;
    }

    if (normalizedPath === normalizedDirectory || normalizedPath === normalizedDirectory.slice(0, -1)) {
      return;
    }

    const anchorText = (anchor.textContent || '').trim();
    const parentClass = anchor.parentElement ? anchor.parentElement.className : '';
    const isDirectoryHint =
      rawHref.endsWith('/') ||
      anchorText.endsWith('/') ||
      /dir/i.test(parentClass);
    const isDirectory = isDirectoryHint || normalizedPath.endsWith('/');
    const fixedPath = isDirectory && !normalizedPath.endsWith('/')
      ? `${normalizedPath}/`
      : normalizedPath;

    const displayName = getDisplayNameFromPath(fixedPath);
    if (!displayName) {
      return;
    }

    const isFinalDirectory = fixedPath.endsWith('/');
    const key = `${isFinalDirectory ? 'd' : 'f'}:${fixedPath}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    entries.push({
      name: displayName,
      pathname: fixedPath,
      isDirectory: isFinalDirectory
    });
  });

  return entries;
}

async function classifyDirectoryEntries(entries) {
  const classified = await Promise.all(entries.map(async (entry) => {
    if (entry.isDirectory) {
      return entry;
    }

    if (VIDEO_EXTENSIONS.has(getFileExtension(entry.name))) {
      return entry;
    }

    const directoryPath = normalizeDirectoryPath(entry.pathname);

    try {
      await fetchDirectoryEntries(directoryPath);
      return {
        ...entry,
        pathname: directoryPath,
        isDirectory: true
      };
    } catch {
      return entry;
    }
  }));

  return classified;
}

function mapEpisodesFromEntries(entries) {
  return entries
    .filter((entry) => !entry.isDirectory && VIDEO_EXTENSIONS.has(getFileExtension(entry.name)))
    .map((entry) => ({
      name: getFileNameWithoutExtension(entry.name),
      path: entry.pathname
    }))
    .sort(sortByName);
}

async function loadShowsIndex() {
  const rootEntries = await fetchDirectoryEntries(serialsRootPath);
  const classifiedRootEntries = await classifyDirectoryEntries(rootEntries);
  const showDirs = classifiedRootEntries
    .filter((entry) => entry.isDirectory)
    .sort(sortByName);

  const index = [];

  for (const showDir of showDirs) {
    const showEntriesRaw = await fetchDirectoryEntries(normalizeDirectoryPath(showDir.pathname));
    const showEntries = await classifyDirectoryEntries(showEntriesRaw);
    const seasonDirs = showEntries
      .filter((entry) => entry.isDirectory)
      .sort(sortByName);
    const rootEpisodes = mapEpisodesFromEntries(showEntries);
    const seasons = [];

    for (const seasonDir of seasonDirs) {
      const seasonEntries = await fetchDirectoryEntries(seasonDir.pathname);
      const episodes = mapEpisodesFromEntries(seasonEntries);

      if (episodes.length > 0) {
        seasons.push({
          name: seasonDir.name,
          episodes
        });
      }
    }

    if (rootEpisodes.length > 0) {
      seasons.unshift({
        name: 'Díly',
        episodes: rootEpisodes,
        synthetic: true
      });
    }

    index.push({
      name: showDir.name,
      seasons,
      hasExplicitSeasons: seasons.some((season) => !season.synthetic)
    });
  }

  return index;
}

async function detectSerialsRootPath() {
  for (const candidate of SERIALS_ROOT_CANDIDATES) {
    try {
      const entries = await fetchDirectoryEntries(candidate);
      const classifiedEntries = await classifyDirectoryEntries(entries);
      const hasShowDir = classifiedEntries.some((entry) => entry.isDirectory);
      const hasVideoInRoot = classifiedEntries.some((entry) => VIDEO_EXTENSIONS.has(getFileExtension(entry.name)));

      if (hasShowDir || hasVideoInRoot) {
        return normalizeDirectoryPath(candidate);
      }
    } catch {
      // Zkusime dalsi moznost.
    }
  }

  return normalizeDirectoryPath(SERIALS_ROOT_CANDIDATES[0]);
}

function renderMainContent() {
  const mode = getPageMode();
  if (mode === 'player') {
    renderPlayerPage();
  } else {
    renderListPage();
  }
}

function createListPanel() {
  const section = document.createElement('section');
  section.className = 'col-12';

  const panel = document.createElement('div');
  panel.className = 'panel h-100';

  const header = document.createElement('div');
  header.className = 'panel-header';
  const title = document.createElement('h2');
  title.className = 'h6 mb-0';
  const listIcon = document.createElement('i');
  listIcon.className = 'bi bi-list-ul me-2';
  title.appendChild(listIcon);
  title.appendChild(document.createTextNode('Seznam'));
  header.appendChild(title);

  const body = document.createElement('div');
  body.className = 'panel-body';
  body.id = 'listContent';

  const loading = document.createElement('p');
  loading.className = 'text-muted small mb-0';
  loading.textContent = 'Načítám obsah...';
  body.appendChild(loading);

  panel.appendChild(header);
  panel.appendChild(body);
  section.appendChild(panel);

  return section;
}

function createPlayerSection() {
  const section = document.createElement('section');
  section.className = 'col-12';

  const panel = document.createElement('div');
  panel.className = 'panel h-100 player-panel';

  const header = document.createElement('div');
  header.className = 'panel-header d-flex flex-column flex-md-row justify-content-between gap-2';

  const headingDiv = document.createElement('div');
  const title = document.createElement('h1');
  title.className = 'h5 mb-1';
  title.id = 'playerTitle';
  title.textContent = 'Vyber díl';

  const meta = document.createElement('p');
  meta.className = 'text-muted small mb-0';
  meta.id = 'playerMeta';
  meta.textContent = 'Vyber seriál a potom díl vlevo.';

  headingDiv.appendChild(title);
  headingDiv.appendChild(meta);
  header.appendChild(headingDiv);

  const body = document.createElement('div');
  body.className = 'panel-body';

  const videoWrap = document.createElement('div');
  videoWrap.className = 'video-wrap';

  const video = document.createElement('video');
  video.id = 'videoPlayer';
  video.controls = true;
  video.preload = 'metadata';
  video.controlsList.add('nodownload');

  videoWrap.appendChild(video);
  body.appendChild(videoWrap);

  const actions = document.createElement('div');
  actions.className = 'd-flex flex-row flex-wrap justify-content-between gap-2 mt-3 player-actions';

  const prevButton = document.createElement('button');
  prevButton.className = 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-2';
  prevButton.type = 'button';
  prevButton.id = 'prevEpisodeBtn';
  prevButton.innerHTML = '<i class="bi bi-rewind-fill"></i>Předchozí díl';

  const backLink = document.createElement('a');
  backLink.className = 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-2';
  backLink.href = 'index.html';
  backLink.innerHTML = '<i class="bi bi-list-ul"></i>Zpět na seznam';

  const nextButton = document.createElement('button');
  nextButton.className = 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-2';
  nextButton.type = 'button';
  nextButton.id = 'nextEpisodeBtn';
  nextButton.innerHTML = '<i class="bi bi-fast-forward-fill"></i>Další díl';

  actions.appendChild(prevButton);
  actions.appendChild(backLink);
  actions.appendChild(nextButton);
  body.appendChild(actions);

  panel.appendChild(header);
  panel.appendChild(body);
  section.appendChild(panel);

  return section;
}

function navigateToEpisode(episodePath) {
  const target = new URL('player.html', window.location.href);
  target.searchParams.set('episode', episodePath);
  window.location.href = target.toString();
}

function createEpisodeButton(showName, seasonName, episode, onSelect) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `tree-button ${episode.path === activeEpisodePath ? 'active' : ''}`;
  button.textContent = episode.name;
  button.addEventListener('click', () => onSelect(showName, seasonName, episode));
  return button;
}


function renderEpisodeTree(container, onSelect) {
  clearElement(container);

  if (shows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-muted small mb-0';
    empty.textContent = `Ve složce ${serialsRootPath} zatím nebyly nalezeny žádné seriály.`;
    container.appendChild(empty);
    return;
  }

  const tree = document.createElement('div');
  tree.className = 'd-flex flex-column gap-1';

  shows.forEach((show, showIndex) => {
    const showIsExpanded = expandedShows.has(showIndex);

    const showButton = document.createElement('button');
    showButton.type = 'button';
    showButton.className = `tree-button tree-toggle ${showIsExpanded ? 'is-expanded' : ''}`;

    const showLabel = document.createElement('span');
    showLabel.textContent = show.name;

    const showIcon = document.createElement('i');
    showIcon.className = `bi ${showIsExpanded ? 'bi-caret-down-fill' : 'bi-caret-right-fill'} tree-icon`;

    showButton.appendChild(showLabel);
    showButton.appendChild(showIcon);
    showButton.addEventListener('click', () => {
      if (expandedShows.has(showIndex)) {
        expandedShows.delete(showIndex);
      } else {
        expandedShows.add(showIndex);
      }
      renderEpisodeTree(container, onSelect);
    });
    tree.appendChild(showButton);

    if (showIsExpanded) {
      const seasonsContainer = document.createElement('div');
      seasonsContainer.className = 'ms-3 d-flex flex-column gap-1';

      show.seasons.forEach((season, seasonIndex) => {
        const seasonKey = `${showIndex}-${seasonIndex}`;
        const seasonIsExpanded = expandedShows.has(seasonKey);

        const seasonButton = document.createElement('button');
        seasonButton.type = 'button';
        seasonButton.className = `tree-button tree-toggle ${seasonIsExpanded ? 'is-expanded' : ''}`;

        const seasonLabel = document.createElement('span');
        seasonLabel.textContent = season.name;

        const seasonIcon = document.createElement('i');
        seasonIcon.className = `bi ${seasonIsExpanded ? 'bi-caret-down-fill' : 'bi-caret-right-fill'} tree-icon`;

        seasonButton.appendChild(seasonLabel);
        seasonButton.appendChild(seasonIcon);
        seasonButton.addEventListener('click', () => {
          if (expandedShows.has(seasonKey)) {
            expandedShows.delete(seasonKey);
          } else {
            expandedShows.add(seasonKey);
          }
          renderEpisodeTree(container, onSelect);
        });
        seasonsContainer.appendChild(seasonButton);

        if (seasonIsExpanded) {
          const episodesContainer = document.createElement('div');
          episodesContainer.className = 'ms-3 d-flex flex-column gap-1';

          season.episodes.forEach((episode) => {
            episodesContainer.appendChild(createEpisodeButton(show.name, season.name, episode, onSelect));
          });
          seasonsContainer.appendChild(episodesContainer);
        }
      });

      tree.appendChild(seasonsContainer);
    }
  });

  container.appendChild(tree);
}

function resetPlayerMessage() {
  const playerTitle = document.getElementById('playerTitle');
  const playerMeta = document.getElementById('playerMeta');

  if (!playerTitle || !playerMeta) return;

  playerTitle.textContent = 'Přehrávač';
  playerMeta.textContent = '';

  if (getPageMode() === 'player') {
    document.title = 'Seriály | Přehrávač';
  }
}

function getPageMode() {
  return document.body.dataset.page || 'list';
}

function renderListPage() {
  clearElement(mainContent);

  const rowDiv = document.createElement('div');
  rowDiv.className = 'row g-3 g-lg-4';

  const listSection = createListPanel();
  rowDiv.appendChild(listSection);

  mainContent.appendChild(rowDiv);

  const listContent = document.getElementById('listContent');
  if (listContent) {
    renderEpisodeTree(listContent, (showName, seasonName, episode) => {
      navigateToEpisode(episode.path);
    });
  }
}

function renderPlayerPage() {
  clearElement(mainContent);

  const rowDiv = document.createElement('div');
  rowDiv.className = 'row g-3 g-lg-4';

  const playerSection = createPlayerSection();
  rowDiv.appendChild(playerSection);
  mainContent.appendChild(rowDiv);

  wirePlayerControls();

  if (activeEpisodeIndex >= 0) {
    setActiveEpisodeByIndex(activeEpisodeIndex, true);
  } else {
    resetPlayerMessage();
    updatePlayerNavButtons();
  }
}

function buildFlatEpisodes() {
  const list = [];
  shows.forEach((show) => {
    show.seasons.forEach((season) => {
      season.episodes.forEach((episode) => {
        list.push({
          showName: show.name,
          seasonName: season.name,
          episode
        });
      });
    });
  });
  return list;
}

function getEpisodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('episode');
  if (!raw) return null;
  return raw;
}

function updateEpisodeUrl(path) {
  const url = new URL(window.location.href);
  url.searchParams.set('episode', path);
  window.history.replaceState({}, '', url);
}

function setActiveEpisodeByIndex(index, skipUrlUpdate = false) {
  if (index < 0 || index >= flatEpisodes.length) return;

  activeEpisodeIndex = index;
  const current = flatEpisodes[index];
  activeEpisodePath = current.episode.path;

  if (!skipUrlUpdate) {
    updateEpisodeUrl(activeEpisodePath);
  }

  const videoPlayer = document.getElementById('videoPlayer');
  const playerTitle = document.getElementById('playerTitle');
  const playerMeta = document.getElementById('playerMeta');

  if (videoPlayer) {
    videoPlayer.src = current.episode.path;
    videoPlayer.load();
  }

  if (playerTitle) {
    playerTitle.textContent = current.episode.name;
  }

  if (playerMeta) {
    playerMeta.textContent = current.showName;
  }

  document.title = `${current.showName} | ${current.episode.name}`;

  updatePlayerNavButtons();
}

function setPlayerFromPathFallback(episodePath) {
  const videoPlayer = document.getElementById('videoPlayer');
  const playerTitle = document.getElementById('playerTitle');
  const playerMeta = document.getElementById('playerMeta');

  const parts = episodePath.split('/').filter(Boolean);
  const filesIndex = parts.lastIndexOf('files');
  const showName = filesIndex >= 0 && parts.length > filesIndex + 1
    ? decodeURIComponent(parts[filesIndex + 1])
    : 'Seriál';
  const fileName = getFileNameWithoutExtension(getDisplayNameFromPath(episodePath));

  if (videoPlayer) {
    videoPlayer.src = episodePath;
    videoPlayer.load();
  }

  if (playerTitle) {
    playerTitle.textContent = fileName;
  }

  if (playerMeta) {
    playerMeta.textContent = showName;
  }

  document.title = `${showName} | ${fileName}`;
  updatePlayerNavButtons();
}

function updatePlayerNavButtons() {
  const prevButton = document.getElementById('prevEpisodeBtn');
  const nextButton = document.getElementById('nextEpisodeBtn');

  if (!prevButton || !nextButton) return;

  prevButton.disabled = activeEpisodeIndex <= 0;
  nextButton.disabled = activeEpisodeIndex < 0 || activeEpisodeIndex >= flatEpisodes.length - 1;
}

function wirePlayerControls() {
  const prevButton = document.getElementById('prevEpisodeBtn');
  const nextButton = document.getElementById('nextEpisodeBtn');

  if (prevButton) {
    prevButton.addEventListener('click', () => {
      if (activeEpisodeIndex > 0) {
        setActiveEpisodeByIndex(activeEpisodeIndex - 1);
      }
    });
  }

  if (nextButton) {
    nextButton.addEventListener('click', () => {
      if (activeEpisodeIndex >= 0 && activeEpisodeIndex < flatEpisodes.length - 1) {
        setActiveEpisodeByIndex(activeEpisodeIndex + 1);
      }
    });
  }
}

async function initialize() {
  const pageMode = getPageMode();
  const episodePath = pageMode === 'player' ? getEpisodeFromUrl() : null;

  if (pageMode === 'player') {
    const cached = loadIndexCache();
    if (cached) {
      serialsRootPath = cached.serialsRootPath || serialsRootPath;
      shows = cached.shows || [];
      flatEpisodes = cached.flatEpisodes || buildFlatEpisodes();
      if (episodePath) {
        const index = flatEpisodes.findIndex((item) => item.episode.path === episodePath);
        if (index >= 0) {
          activeEpisodeIndex = index;
          activeEpisodePath = episodePath;
        }
      }
      initializeTheme();
      renderMainContent();
      if (episodePath && activeEpisodeIndex < 0) {
        setPlayerFromPathFallback(episodePath);
      }
      return;
    }
  }

  try {
    serialsRootPath = await detectSerialsRootPath();
    shows = await loadShowsIndex();
    flatEpisodes = buildFlatEpisodes();
    saveIndexCache();

    initializeTheme();

    if (pageMode === 'player' && episodePath) {
      const index = flatEpisodes.findIndex((item) => item.episode.path === episodePath);
      if (index >= 0) {
        activeEpisodeIndex = index;
        activeEpisodePath = episodePath;
      }
    }

    renderMainContent();

    if (pageMode === 'player' && episodePath && activeEpisodeIndex < 0) {
      setPlayerFromPathFallback(episodePath);
    }
  } catch (error) {
    console.error('Nepodařilo se načíst data:', error);

    if (pageMode === 'player' && episodePath) {
      renderMainContent();
      setPlayerFromPathFallback(episodePath);
      return;
    }

    clearElement(mainContent);

    const container = document.createElement('div');
    container.className = 'alert alert-danger';
    container.role = 'alert';

    const errorMessage = document.createElement('p');
    errorMessage.className = 'mb-2';
    errorMessage.textContent = 'Nepodařilo se načíst seznam seriálů (zkontroluj zapnutý directory listing v lighttpd).';
    container.appendChild(errorMessage);

    const details = document.createElement('p');
    details.className = 'text-muted small mb-0';
    details.textContent = `Použitá cesta pro indexaci: ${serialsRootPath}`;
    container.appendChild(details);

    mainContent.appendChild(container);
  }
}

/* Theme Switching */
function initializeTheme() {
  const themeToggle = document.getElementById('themeToggle');
  if (!themeToggle) return;

  // Check localStorage for saved preference
  const savedTheme = localStorage.getItem('theme');

  // Determine initial theme
  let currentTheme;
  if (savedTheme) {
    currentTheme = savedTheme;
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    currentTheme = 'dark';
  } else {
    currentTheme = 'light';
  }

  // Apply theme
  setTheme(currentTheme);

  // Add click listener
  themeToggle.addEventListener('click', () => {
    const htmlElement = document.documentElement;
    const theme = htmlElement.getAttribute('data-theme') || 'light';
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    htmlElement.classList.add('theme-switching');
    setTheme(newTheme);
    localStorage.setItem('theme', newTheme);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        htmlElement.classList.remove('theme-switching');
      });
    });
  });

  // If user has not saved an explicit preference, listen for system changes
  if (!savedTheme && window.matchMedia) {
    try {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = (e) => {
        // Only update if user hasn't saved a preference
        if (!localStorage.getItem('theme')) {
          setTheme(e.matches ? 'dark' : 'light');
        }
      };
      if (mql.addEventListener) {
        mql.addEventListener('change', listener);
      } else if (mql.addListener) {
        mql.addListener(listener);
      }
    } catch (err) {
      // ignore
    }
  }
}

function setTheme(theme) {
  const htmlElement = document.documentElement;
  const themeToggle = document.getElementById('themeToggle');

  // Always set explicit data-theme so user choice overrides system
  if (theme === 'dark') {
    htmlElement.setAttribute('data-theme', 'dark');
    if (themeToggle) {
      themeToggle.innerHTML = '<i class="bi bi-moon-stars-fill"></i>';
    }
  } else {
    htmlElement.setAttribute('data-theme', 'light');
    if (themeToggle) {
      themeToggle.innerHTML = '<i class="bi bi-brightness-high-fill"></i>';
    }
  }
}

initialize();
