const mainContent = document.getElementById('mainContent');
const showNav = document.getElementById('showNav');

const APP_BASE_URL = new URL('.', window.location.href);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v']);
const SERIALS_ROOT_CANDIDATES = Array.from(new Set([
  new URL('serialy/', APP_BASE_URL).pathname,
  '/serialy/',
  APP_BASE_URL.pathname
]));

let shows = [];
let activeEpisodePath = null;
let expandedShows = new Set();
let serialsRootPath = SERIALS_ROOT_CANDIDATES[0];

function clearElement(element) {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
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
  const response = await fetch(normalizedDirectory, { cache: 'no-store' });

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
  clearElement(mainContent);

  const rowDiv = document.createElement('div');
  rowDiv.className = 'row g-3 g-lg-4';

  const sidebarAside = createSidebarPanel();
  rowDiv.appendChild(sidebarAside);

  if (activeEpisodePath === null) {
    const placeholderSection = document.createElement('section');
    placeholderSection.className = 'col-12 col-lg-8 col-xl-9';

    const panel = document.createElement('div');
    panel.className = 'panel h-100 d-flex align-items-center justify-content-center';
    panel.style.minHeight = '60vh';

    const message = document.createElement('p');
    message.className = 'text-center text-muted';
    message.textContent = 'Vyberte díl ze seznamu vlevo.';

    panel.appendChild(message);
    placeholderSection.appendChild(panel);
    rowDiv.appendChild(placeholderSection);
  } else {
    const playerSection = createPlayerSection();
    rowDiv.appendChild(playerSection);
  }

  mainContent.appendChild(rowDiv);
  renderSidebar();

  if (activeEpisodePath !== null) {
    resetPlayerMessage();
  }
}

function createSidebarPanel() {
  const aside = document.createElement('aside');
  aside.className = 'col-12 col-lg-4 col-xl-3';

  const panel = document.createElement('div');
  panel.className = 'panel h-100';

  const header = document.createElement('div');
  header.className = 'panel-header';
  const title = document.createElement('h2');
  title.className = 'h6 mb-0';
  title.textContent = 'Díly';
  header.appendChild(title);

  const body = document.createElement('div');
  body.className = 'panel-body';
  body.id = 'sidebarContent';

  const loading = document.createElement('p');
  loading.className = 'text-muted small mb-0';
  loading.textContent = 'Načítám obsah...';
  body.appendChild(loading);

  panel.appendChild(header);
  panel.appendChild(body);
  aside.appendChild(panel);

  return aside;
}

function createPlayerSection() {
  const section = document.createElement('section');
  section.className = 'col-12 col-lg-8 col-xl-9';

  const panel = document.createElement('div');
  panel.className = 'panel h-100';

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

  panel.appendChild(header);
  panel.appendChild(body);
  section.appendChild(panel);

  return section;
}

function playEpisode(showName, seasonName, episode) {
  activeEpisodePath = episode.path;
  renderMainContent();

  const videoPlayer = document.getElementById('videoPlayer');
  const playerTitle = document.getElementById('playerTitle');
  const playerMeta = document.getElementById('playerMeta');

  if (videoPlayer) {
    videoPlayer.src = episode.path;
    videoPlayer.load();
  }

  if (playerTitle) {
    playerTitle.textContent = episode.name;
  }

  if (playerMeta) {
    playerMeta.textContent = `${showName} | ${seasonName}`;
  }
}

function createEpisodeButton(showName, seasonName, episode) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `tree-button ${episode.path === activeEpisodePath ? 'active' : ''}`;
  button.textContent = episode.name;
  button.addEventListener('click', () => playEpisode(showName, seasonName, episode));
  return button;
}

function renderFlatEpisodeList(show) {
  const list = document.createElement('div');
  list.className = 'd-flex flex-column gap-2';

  const season = show.seasons[0];
  for (const episode of season.episodes) {
    list.appendChild(createEpisodeButton(show.name, season.name, episode));
  }

  return list;
}

function renderSeasonAccordion(show) {
  const accordion = document.createElement('div');
  accordion.className = 'accordion';
  accordion.id = `seasonAccordion-${activeShowIndex}`;

  show.seasons.forEach((season, seasonIndex) => {
    const collapseId = `collapse-${activeShowIndex}-${seasonIndex}`;
    const headingId = `heading-${activeShowIndex}-${seasonIndex}`;
    const item = document.createElement('div');
    item.className = 'accordion-item';

    const header = document.createElement('h2');
    header.className = 'accordion-header';
    header.id = headingId;

    const headerButton = document.createElement('button');
    headerButton.className = `accordion-button ${seasonIndex === 0 ? '' : 'collapsed'}`;
    headerButton.type = 'button';
    headerButton.setAttribute('data-bs-toggle', 'collapse');
    headerButton.setAttribute('data-bs-target', `#${collapseId}`);
    headerButton.setAttribute('aria-expanded', seasonIndex === 0 ? 'true' : 'false');
    headerButton.setAttribute('aria-controls', collapseId);
    headerButton.textContent = season.name;

    header.appendChild(headerButton);

    const collapse = document.createElement('div');
    collapse.id = collapseId;
    collapse.className = `accordion-collapse collapse ${seasonIndex === 0 ? 'show' : ''}`;
    collapse.setAttribute('aria-labelledby', headingId);
    collapse.setAttribute('data-bs-parent', `#${accordion.id}`);

    const body = document.createElement('div');
    body.className = 'accordion-body d-flex flex-column gap-2';

    season.episodes.forEach((episode) => {
      body.appendChild(createEpisodeButton(show.name, season.name, episode));
    });

    collapse.appendChild(body);
    item.appendChild(header);
    item.appendChild(collapse);
    accordion.appendChild(item);
  });

  return accordion;
}

function renderNavbar() {
  clearElement(showNav);
}

function renderSidebar() {
  const sidebarContent = document.getElementById('sidebarContent');
  if (!sidebarContent) return;

  clearElement(sidebarContent);

  if (shows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'text-muted small mb-0';
    empty.textContent = `Ve složce ${serialsRootPath} zatím nebyly nalezeny žádné seriály.`;
    sidebarContent.appendChild(empty);
    return;
  }

  const tree = document.createElement('div');
  tree.className = 'd-flex flex-column gap-1';

  shows.forEach((show, showIndex) => {
    const showIsExpanded = expandedShows.has(showIndex);

    const showButton = document.createElement('button');
    showButton.type = 'button';
    showButton.className = 'tree-button';
    showButton.textContent = show.name;
    showButton.addEventListener('click', () => {
      if (expandedShows.has(showIndex)) {
        expandedShows.delete(showIndex);
      } else {
        expandedShows.add(showIndex);
      }
      renderSidebar();
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
        seasonButton.className = 'tree-button';
        seasonButton.textContent = season.name;
        seasonButton.addEventListener('click', () => {
          if (expandedShows.has(seasonKey)) {
            expandedShows.delete(seasonKey);
          } else {
            expandedShows.add(seasonKey);
          }
          renderSidebar();
        });
        seasonsContainer.appendChild(seasonButton);

        if (seasonIsExpanded) {
          const episodesContainer = document.createElement('div');
          episodesContainer.className = 'ms-3 d-flex flex-column gap-1';

          season.episodes.forEach((episode) => {
            episodesContainer.appendChild(createEpisodeButton(show.name, season.name, episode));
          });
          seasonsContainer.appendChild(episodesContainer);
        }
      });

      tree.appendChild(seasonsContainer);
    }
  });

  sidebarContent.appendChild(tree);
}

function resetPlayerMessage() {
  const playerTitle = document.getElementById('playerTitle');
  const playerMeta = document.getElementById('playerMeta');

  if (!playerTitle || !playerMeta) return;

  playerTitle.textContent = 'Přehrávač';
  playerMeta.textContent = '';
}

async function initialize() {
  try {
    serialsRootPath = await detectSerialsRootPath();
    shows = await loadShowsIndex();

    renderNavbar();

      initializeTheme();
    renderMainContent();
  } catch (error) {
    console.error('Nepodařilo se načíst data:', error);
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
