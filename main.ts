import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	WorkspaceLeaf,
	ItemView,
	requestUrl,
	Menu,
	Notice,
	TextAreaComponent,
} from 'obsidian';

interface PluginSet {
	name: string;
	plugins: string[]; // array of full_name
}

interface PluginSettings {
	extraVaultPaths: string[];
	parentVaultDirectories: string[];
	pluginSets: PluginSet[];
	installLocation: 'active' | 'all' | 'selected';
	installedRepoMap: Record<string, string>;
	githubToken: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	extraVaultPaths: [],
	parentVaultDirectories: [],
	pluginSets: [],
	installLocation: 'all',
	installedRepoMap: {},
	githubToken: '',
};

export const VIEW_TYPE_BROWSER = 'extension-hub-view';

interface GithubRepo {
	full_name: string;
	description: string;
	stargazers_count: number;
	html_url: string;
	isDesktopOnly?: boolean;
	author?: string;
	owner: { login: string; avatar_url: string };
}

interface GithubUser {
	login: string;
	avatar_url: string;
	html_url: string;
	type: string;
}

interface OfficialCommunityPlugin {
	id: string;
	repo: string;
	name?: string;
	author?: string;
	description?: string;
}

interface PluginUpdateCandidate {
	pluginId: string;
	currentVersion: string;
	latestVersion?: string;
	repo?: string;
	source: 'official' | 'tracked' | 'detected' | 'unknown';
	versionStatus: 'update-available' | 'up-to-date' | 'local-newer' | 'unknown';
	needsUpdate: boolean;
	error?: string;
}

interface ObsidianManifest {
	id: string;
	name?: string;
	version: string;
	author?: string;
	authorUrl?: string;
	isDesktopOnly?: boolean;
	desktopOnly?: boolean;
}

interface GithubReleaseAsset {
	name: string;
	browser_download_url: string;
}

interface GithubRelease {
	assets: GithubReleaseAsset[];
	tag_name?: string;
}

interface ObsidianPluginManager {
	manifests: Record<string, ObsidianManifest>;
	loadManifests?: () => Promise<void>;
}

interface RawCommunityPlugin {
	id: string;
	name: string;
	author: string;
	description: string;
	repo: string;
}

interface RawForumTopic {
	id: number;
	title: string;
	slug: string;
	posts_count?: number;
	like_count?: number;
	views?: number;
	tags?: string[];
}

interface RawForumPost {
	topic_id: number;
	topic_title: string;
	topic_slug: string;
	like_count?: number;
}

interface RawForumResponse {
	topics?: RawForumTopic[];
	posts?: RawForumPost[];
}

interface GithubSearchResponse<T> {
	items?: T[];
}

interface NodeFsLike {
	existsSync(path: string): boolean;
	readdirSync(path: string): string[];
	statSync(path: string): { isDirectory(): boolean };
	mkdirSync(path: string, options?: { recursive?: boolean }): void;
	writeFileSync(path: string, data: string): void;
}

interface NodePathLike {
	join(...parts: string[]): string;
}

interface NodeApi {
	fs: NodeFsLike;
	path: NodePathLike;
}

function getNodeApi(): NodeApi | null {
	const r = (window as unknown as { require?: (id: string) => unknown }).require;
	if (typeof r !== 'function') return null;
	try {
		return {
			fs: r('fs') as NodeFsLike,
			path: r('path') as NodePathLike,
		};
	} catch {
		return null;
	}
}

const DESKTOP_ONLY_CACHE: Record<string, boolean> = {};

interface ForumResult {
	title: string;
	slug: string;
	id: number;
	posts_count?: number;
	like_count?: number;
	views?: number;
	tags?: string[];
}

class ForumService {
	static async search(query: string): Promise<ForumResult[]> {
		const q = query.trim();
		const searchQuery = q ? `${q} category:9` : `category:9`;
		const url = `https://forum.obsidian.md/search.json?q=${encodeURIComponent(searchQuery)}`;

		try {
			const response = await requestUrl({ url });
			const data = response.json as RawForumResponse;
			const topics = data.topics ?? [];
			const posts = data.posts ?? [];

			const postTopics: ForumResult[] = posts.map((p) => ({
				title: p.topic_title,
				slug: p.topic_slug,
				id: p.topic_id,
				posts_count: 0,
				like_count: p.like_count,
				views: 0,
				tags: [],
			}));

			const topicResults: ForumResult[] = topics.map((t) => ({
				title: t.title,
				slug: t.slug,
				id: t.id,
				posts_count: t.posts_count,
				like_count: t.like_count,
				views: t.views,
				tags: t.tags ?? [],
			}));

			const seenIds = new Set<number>();
			const uniqueItems: ForumResult[] = [];
			for (const item of [...topicResults, ...postTopics]) {
				if (!seenIds.has(item.id)) {
					seenIds.add(item.id);
					uniqueItems.push(item);
				}
			}
			return uniqueItems;
		} catch (e) {
			console.error('Forum search failed', e);
			return [];
		}
	}
}

class CommunityArchiveService {
	static async search(query: string): Promise<GithubRepo[]> {
		const url =
			'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';
		const response = await requestUrl({ url });
		const plugins = (response.json as RawCommunityPlugin[]) ?? [];
		const searchLower = query.toLowerCase().trim();

		const isPluginSearch = searchLower === 'plugin' || searchLower === 'plugins';
		const searchSingular =
			searchLower.length > 3 && searchLower.endsWith('s')
				? searchLower.slice(0, -1)
				: searchLower;

		return plugins
			.filter((p) => {
				if (!searchLower) return true;
				if (isPluginSearch) return true;

				const name = (p.name || '').toLowerCase();
				const author = (p.author || '').toLowerCase();
				const description = (p.description || '').toLowerCase();
				const id = (p.id || '').toLowerCase();

				return (
					name.includes(searchLower) ||
					name.includes(searchSingular) ||
					author.includes(searchLower) ||
					description.includes(searchLower) ||
					description.includes(searchSingular) ||
					id.includes(searchLower)
				);
			})
			.map((p) => ({
				full_name: p.repo,
				description: p.description,
				stargazers_count: 0,
				html_url: `https://github.com/${p.repo}`,
				owner: {
					login: p.repo.split('/')[0],
					avatar_url: '',
				},
			}));
	}
}

class GithubService {
	private static token = '';

	static setToken(token?: string) {
		this.token = (token || '').trim();
	}

	private static buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: 'application/vnd.github.v3+json',
		};
		if (this.token) {
			headers['Authorization'] = `Bearer ${this.token}`;
		}
		return headers;
	}

	static async searchUsers(query: string): Promise<GithubUser[]> {
		const url = `https://api.github.com/search/users?q=${encodeURIComponent(query)}&per_page=10`;
		try {
			const response = await requestUrl({
				url,
				method: 'GET',
				headers: this.buildHeaders(),
			});
			const json = response.json as GithubSearchResponse<GithubUser>;
			return json.items ?? [];
		} catch (e) {
			console.error('User search failed', e);
			return [];
		}
	}

	static async searchPlugins(query: string, sort = 'stars'): Promise<GithubRepo[]> {
		const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=${sort}&order=desc`;
		try {
			const response = await requestUrl({
				url,
				method: 'GET',
				headers: this.buildHeaders(),
			});
			const json = response.json as GithubSearchResponse<GithubRepo>;
			return json.items ?? [];
		} catch (error) {
			const err = error as { status?: number; message?: string };
			if (err.status === 403) {
				throw new Error('Request failed, status 403 (Rate Limit Exceeded)');
			}
			throw error;
		}
	}

	static async getLatestRelease(fullName: string): Promise<GithubRelease> {
		const url = `https://api.github.com/repos/${fullName}/releases/latest`;
		const response = await requestUrl({
			url,
			method: 'GET',
			headers: this.buildHeaders(),
		});
		return response.json as GithubRelease;
	}
}

export default class ExtensionHub extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();
		GithubService.setToken(this.settings.githubToken);

		this.addRibbonIcon('search', 'Browse Plugins', () => {
			void this.activateView();
		});

		this.addSettingTab(new ExtensionHubSettingTab(this.app, this));

		this.addCommand({
			id: 'update-installed-plugins-from-github',
			name: 'Check installed plugins for GitHub updates',
			callback: async () => {
				const candidates = await this.checkInstalledPluginUpdates();
				const repos = candidates
					.filter((candidate) => candidate.needsUpdate && candidate.repo)
					.map((candidate) => candidate.repo as string);
				if (repos.length === 0) {
					new Notice('No updates found for installed plugins.');
					return;
				}
				const { updated, failed } = await this.updatePluginsByRepo(repos);
				new Notice(
					`Update finished: ${updated} updated${failed > 0 ? `, ${failed} failed` : ''}.`,
				);
			},
		});

		this.registerView(VIEW_TYPE_BROWSER, (leaf) => new PluginBrowserView(leaf, this));
	}

	onunload() {
		// Intentionally do not detach leaves here; Obsidian preserves user-arranged layouts.
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_BROWSER);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getLeaf('tab');
			await leaf.setViewState({
				type: VIEW_TYPE_BROWSER,
				active: true,
			});
		}

		await workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		GithubService.setToken(this.settings.githubToken);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private getPluginManager(): ObsidianPluginManager | undefined {
		return (this.app as unknown as { plugins?: ObsidianPluginManager }).plugins;
	}

	private async getOfficialCommunityPlugins(): Promise<OfficialCommunityPlugin[]> {
		const url =
			'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';
		const response = await requestUrl({ url });
		return (response.json as OfficialCommunityPlugin[]) ?? [];
	}

	private async getInstalledPluginManifestFromDisk(
		pluginId: string,
	): Promise<ObsidianManifest | null> {
		const manifestPath = `${this.app.vault.configDir}/plugins/${pluginId}/manifest.json`;
		try {
			if (!(await this.app.vault.adapter.exists(manifestPath))) {
				return null;
			}
			const content = await this.app.vault.adapter.read(manifestPath);
			return JSON.parse(content) as ObsidianManifest;
		} catch {
			return null;
		}
	}

	private compareVersions(current: string, latest: string): number {
		const normalize = (version: string) =>
			version.split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
		const currentParts = normalize(current);
		const latestParts = normalize(latest);
		const maxLen = Math.max(currentParts.length, latestParts.length);

		for (let i = 0; i < maxLen; i++) {
			const a = currentParts[i] ?? 0;
			const b = latestParts[i] ?? 0;
			if (a < b) return -1;
			if (a > b) return 1;
		}
		return 0;
	}

	private async getLatestManifestVersionFromRepo(fullName: string): Promise<string | null> {
		const release = await GithubService.getLatestRelease(fullName);
		const assets = release.assets ?? [];
		const manifestAsset = assets.find((asset) => asset.name === 'manifest.json');
		if (!manifestAsset?.browser_download_url) {
			return null;
		}

		const manifestResp = await requestUrl({ url: manifestAsset.browser_download_url });
		const json = manifestResp.json as ObsidianManifest | undefined;
		return json?.version ?? null;
	}

	private async repoMatchesPluginId(fullName: string, pluginId: string): Promise<boolean> {
		try {
			const manifestUrl = `https://raw.githubusercontent.com/${fullName}/HEAD/manifest.json`;
			const manifestResp = await requestUrl({ url: manifestUrl });
			const json = manifestResp.json as ObsidianManifest | undefined;
			return manifestResp.status === 200 && json?.id === pluginId;
		} catch {
			return false;
		}
	}

	private parseGithubOwnerFromAuthorUrl(authorUrl?: string): string | undefined {
		if (!authorUrl) return undefined;
		const match = authorUrl.match(/github\.com\/(?:users\/)?([^/]+)/i);
		return match?.[1];
	}

	private normalizeRepoToken(input?: string): string | undefined {
		if (!input) return undefined;
		return input
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
	}

	private compactRepoToken(input?: string): string | undefined {
		if (!input) return undefined;
		const normalized = this.normalizeRepoToken(input);
		if (!normalized) return undefined;
		return normalized.replace(/-/g, '');
	}

	private async findRepoByKnownPatterns(
		pluginId: string,
		manifest: ObsidianManifest,
	): Promise<string | undefined> {
		const owner = this.parseGithubOwnerFromAuthorUrl(manifest.authorUrl);
		if (!owner) return undefined;

		const idToken = this.normalizeRepoToken(pluginId);
		const nameToken = this.normalizeRepoToken(manifest.name);
		const compactIdToken = this.compactRepoToken(pluginId);
		const compactNameToken = this.compactRepoToken(manifest.name);
		const candidates = [
			idToken ? `${owner}/obsidian-${idToken}` : undefined,
			idToken ? `${owner}/${idToken}` : undefined,
			compactIdToken ? `${owner}/${compactIdToken}` : undefined,
			nameToken ? `${owner}/obsidian-${nameToken}` : undefined,
			nameToken ? `${owner}/${nameToken}` : undefined,
			compactNameToken ? `${owner}/${compactNameToken}` : undefined,
			idToken ? `${owner}/obsidian-plugin-${idToken}` : undefined,
		].filter((candidate): candidate is string => Boolean(candidate));

		for (const repo of [...new Set(candidates)]) {
			if (await this.repoMatchesPluginId(repo, pluginId)) {
				return repo;
			}
		}
		return undefined;
	}

	private async findRepoByManifestId(
		pluginId: string,
		manifest: ObsidianManifest,
	): Promise<{ repo?: string; reason?: string }> {
		const fromKnownPattern = await this.findRepoByKnownPatterns(pluginId, manifest);
		if (fromKnownPattern) {
			return { repo: fromKnownPattern };
		}

		const owner = this.parseGithubOwnerFromAuthorUrl(manifest.authorUrl);
		const queries = [
			owner ? `user:${owner} obsidian ${pluginId} in:name` : undefined,
			`obsidian ${pluginId} in:name`,
			`"${pluginId}" obsidian plugin`,
		].filter((query): query is string => Boolean(query));

		let rateLimited = false;

		for (const query of queries) {
			let repos: GithubRepo[] = [];
			try {
				repos = await GithubService.searchPlugins(query, 'updated');
			} catch (e) {
				const err = e as { message?: string };
				if ((err.message ?? '').includes('403')) {
					rateLimited = true;
				}
				continue;
			}

			for (const repo of repos.slice(0, 12)) {
				if (await this.repoMatchesPluginId(repo.full_name, pluginId)) {
					return { repo: repo.full_name };
				}
			}
		}

		if (rateLimited) {
			return { reason: 'GitHub API rate limit reached during repository detection.' };
		}
		return { reason: 'No GitHub repository with matching manifest id was found.' };
	}

	async checkInstalledPluginUpdates(): Promise<PluginUpdateCandidate[]> {
		const pluginManager = this.getPluginManager();
		if (pluginManager?.loadManifests) {
			try {
				await pluginManager.loadManifests();
			} catch {
				// Ignore and continue with available manifests
			}
		}
		const manifests = pluginManager?.manifests ?? {};
		const installedPluginIds = Object.keys(manifests);

		if (installedPluginIds.length === 0) {
			return [];
		}

		const officialPlugins = await this.getOfficialCommunityPlugins();
		const repoById = new Map<string, string>();
		for (const p of officialPlugins) {
			if (p?.id && p?.repo) {
				repoById.set(p.id, p.repo);
			}
		}

		let mappingChanged = false;
		const candidates: PluginUpdateCandidate[] = [];

		for (const pluginId of installedPluginIds) {
			const installedManifestFromDisk = await this.getInstalledPluginManifestFromDisk(pluginId);
			const installedManifest: ObsidianManifest =
				installedManifestFromDisk ?? manifests[pluginId] ?? ({ id: pluginId, version: '0.0.0' } as ObsidianManifest);
			const currentVersion = installedManifest.version || '0.0.0';
			let repo = repoById.get(pluginId);
			let source: PluginUpdateCandidate['source'] = repo ? 'official' : 'unknown';
			let unresolvedReason = 'Could not map plugin to a GitHub repository.';

			if (!repo && this.settings.installedRepoMap[pluginId]) {
				repo = this.settings.installedRepoMap[pluginId];
				source = 'tracked';
			}

			if (!repo) {
				const detected = await this.findRepoByManifestId(pluginId, installedManifest);
				repo = detected.repo;
				if (!repo && detected.reason) {
					unresolvedReason = detected.reason;
				}
				if (repo) {
					this.settings.installedRepoMap[pluginId] = repo;
					mappingChanged = true;
					source = 'detected';
				}
			}

			if (!repo) {
				candidates.push({
					pluginId,
					currentVersion,
					source: 'unknown',
					versionStatus: 'unknown',
					needsUpdate: false,
					error: unresolvedReason,
				});
				continue;
			}

			try {
				const latestVersion = await this.getLatestManifestVersionFromRepo(repo);
				if (!latestVersion) {
					candidates.push({
						pluginId,
						currentVersion,
						repo,
						source,
						versionStatus: 'unknown',
						needsUpdate: false,
						error: 'No manifest.json in latest release.',
					});
					continue;
				}

				const versionCompare = this.compareVersions(currentVersion, latestVersion);
				const needsUpdate = versionCompare < 0;
				const versionStatus: PluginUpdateCandidate['versionStatus'] =
					versionCompare < 0
						? 'update-available'
						: versionCompare === 0
							? 'up-to-date'
							: 'local-newer';
				candidates.push({
					pluginId,
					currentVersion,
					latestVersion,
					repo,
					source,
					versionStatus,
					needsUpdate,
				});
			} catch (e) {
				const err = e as { message?: string };
				candidates.push({
					pluginId,
					currentVersion,
					repo,
					source,
					versionStatus: 'unknown',
					needsUpdate: false,
					error: err.message ?? 'Failed to check latest release.',
				});
			}
		}

		if (mappingChanged) {
			await this.saveSettings();
		}

		return candidates.sort((a, b) => {
			if (a.needsUpdate !== b.needsUpdate) {
				return a.needsUpdate ? -1 : 1;
			}
			return a.pluginId.localeCompare(b.pluginId);
		});
	}

	async updatePluginsByRepo(repos: string[]): Promise<{ updated: number; failed: number }> {
		let updated = 0;
		let failed = 0;
		const uniqueRepos = [...new Set(repos)];

		for (const fullName of uniqueRepos) {
			try {
				await this.installPluginFromGithub(fullName, { showNotice: false });
				updated++;
			} catch (e) {
				console.error(`Failed to update ${fullName}`, e);
				failed++;
			}
		}

		return { updated, failed };
	}

	async installPluginFromGithub(fullName: string, options: { showNotice?: boolean } = {}) {
		const showNotice = options.showNotice ?? true;
		const release = await GithubService.getLatestRelease(fullName);
		const assets = release.assets;

		const mainJs = assets.find((a) => a.name === 'main.js');
		const manifestJson = assets.find((a) => a.name === 'manifest.json');
		const stylesCss = assets.find((a) => a.name === 'styles.css');

		if (!mainJs || !manifestJson) {
			throw new Error(
				'Plugin does not have required release assets (main.js and manifest.json).',
			);
		}

		const manifestResp = await requestUrl({ url: manifestJson.browser_download_url });
		const manifest = manifestResp.json as ObsidianManifest;
		const pluginId = manifest.id;
		if (pluginId && this.settings.installedRepoMap[pluginId] !== fullName) {
			this.settings.installedRepoMap[pluginId] = fullName;
			await this.saveSettings();
		}

		const configDir = this.app.vault.configDir;
		const pluginDir = `${configDir}/plugins/${pluginId}`;

		const mainJsResp = await requestUrl({ url: mainJs.browser_download_url });
		const manifestContent = JSON.stringify(manifest, null, 2);
		let stylesContent = '';
		if (stylesCss) {
			const stylesResp = await requestUrl({ url: stylesCss.browser_download_url });
			stylesContent = stylesResp.text;
		}

		const installToActive =
			this.settings.installLocation === 'active' || this.settings.installLocation === 'all';
		const useParentDirs = this.settings.installLocation === 'all';
		const useSelectedVaults =
			this.settings.installLocation === 'all' || this.settings.installLocation === 'selected';

		if (installToActive) {
			if (!(await this.app.vault.adapter.exists(pluginDir))) {
				await this.app.vault.adapter.mkdir(pluginDir);
			}
			await this.app.vault.adapter.write(`${pluginDir}/main.js`, mainJsResp.text);
			await this.app.vault.adapter.write(`${pluginDir}/manifest.json`, manifestContent);
			if (stylesCss) {
				await this.app.vault.adapter.write(`${pluginDir}/styles.css`, stylesContent);
			}
		}

		let targetVaultsCount = 0;

		// Multi-Vault Deployment Logic (Desktop only — uses node fs)
		if (useParentDirs || useSelectedVaults) {
			const node = getNodeApi();
			if (node) {
				try {
					const { fs, path } = node;
					const targetVaults: string[] = [];

					if (useSelectedVaults) {
						targetVaults.push(...this.settings.extraVaultPaths);
					}

					if (useParentDirs) {
						for (const parentPath of this.settings.parentVaultDirectories) {
							if (fs.existsSync(parentPath)) {
								const subfolders = fs.readdirSync(parentPath);
								for (const sub of subfolders) {
									const fullPath = path.join(parentPath, sub);
									const obsidianFolder = path.join(fullPath, configDir);
									if (
										fs.statSync(fullPath).isDirectory() &&
										fs.existsSync(obsidianFolder)
									) {
										if (!targetVaults.includes(fullPath)) {
											targetVaults.push(fullPath);
										}
									}
								}
							}
						}
					}

					for (const vaultPath of targetVaults) {
						const targetDir = path.join(vaultPath, configDir, 'plugins', pluginId);
						if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

						fs.writeFileSync(path.join(targetDir, 'main.js'), mainJsResp.text);
						fs.writeFileSync(path.join(targetDir, 'manifest.json'), manifestContent);
						if (stylesCss) {
							fs.writeFileSync(path.join(targetDir, 'styles.css'), stylesContent);
						}
					}
					targetVaultsCount = targetVaults.length;
				} catch (e) {
					console.error('Failed to copy to extra vaults:', e);
				}
			}
		}

		// Reload plugins
		const pluginManager = this.getPluginManager();
		if (pluginManager?.loadManifests) {
			await pluginManager.loadManifests();
		}
		if (showNotice) {
			new Notice(
				`Installed ${fullName}${installToActive ? ' to active vault' : ''}${
					targetVaultsCount > 0 ? ` and ${targetVaultsCount} extra vaults` : ''
				}.`,
			);
		}
	}
}

class PluginBrowserView extends ItemView {
	plugin: ExtensionHub;

	constructor(leaf: WorkspaceLeaf, plugin: ExtensionHub) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_BROWSER;
	}

	getDisplayText() {
		return 'Plugin Browser';
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.createEl('h4', { text: 'Search Obsidian Plugins' });

		const searchContainer = container.createDiv({ cls: 'search-container' });
		const input = searchContainer.createEl('input', {
			type: 'text',
			placeholder: 'Plugin name, keyword, or @author...',
			cls: 'eh-search-input',
		});

		const btnRow = searchContainer.createDiv({ cls: 'eh-btn-row' });

		const archiveBtn = btnRow.createEl('button', { text: 'Official Archive' });
		const githubBtn = btnRow.createEl('button', { text: 'Search GitHub' });
		const forumBtn = btnRow.createEl('button', { text: 'Search Forum' });
		const checkUpdatesBtn = btnRow.createEl('button', { text: 'Check Updates' });

		const results = container.createDiv({ cls: 'results-container' });

		const renderUpdateCandidates = (candidates: PluginUpdateCandidate[]) => {
			results.empty();

			if (candidates.length === 0) {
				results.createEl('p', { text: 'No installed plugins found.' });
				return;
			}

			const updatable = candidates.filter((candidate) => candidate.repo);
			const needsUpdate = updatable.filter(
				(candidate) => candidate.versionStatus === 'update-available',
			);
			const upToDate = updatable.filter(
				(candidate) => candidate.versionStatus === 'up-to-date',
			);
			const localNewer = updatable.filter(
				(candidate) => candidate.versionStatus === 'local-newer',
			);
			const unknownVersion = updatable.filter(
				(candidate) => candidate.versionStatus === 'unknown',
			);
			const unresolved = candidates.filter((candidate) => !candidate.repo);

			results.createEl('h4', { text: 'Plugin updates' });
			results.createEl('p', {
				text: `${needsUpdate.length} update(s) available, ${upToDate.length} up to date, ${localNewer.length} local newer than latest release, ${unknownVersion.length} unknown version status, ${unresolved.length} unresolved.`,
			});

			if (needsUpdate.length > 0) {
				const controls = results.createDiv({ cls: 'eh-controls-row' });

				const updateSelectedBtn = controls.createEl('button', {
					text: 'Update Selected',
					cls: 'mod-cta',
				});
				const selectAllBtn = controls.createEl('button', { text: 'Select All' });
				const clearBtn = controls.createEl('button', { text: 'Clear' });

				const checkboxMap = new Map<string, HTMLInputElement>();

				for (const candidate of needsUpdate) {
					const row = results.createDiv({ cls: 'plugin-result-item eh-update-row' });

					const checkbox = row.createEl('input', { type: 'checkbox' });
					checkbox.checked = candidate.needsUpdate;

					const details = row.createDiv();
					details.createEl('strong', {
						text: `${candidate.pluginId} (Installed ${candidate.currentVersion}, Latest ${candidate.latestVersion || 'unknown'})`,
					});
					details.createEl('div', { text: `${candidate.repo} [${candidate.source}]` });
					if (candidate.error) {
						details.createEl('div', { text: candidate.error });
					}

					checkboxMap.set(candidate.pluginId, checkbox);
				}

				selectAllBtn.addEventListener('click', () => {
					checkboxMap.forEach((checkbox) => {
						checkbox.checked = true;
					});
				});

				clearBtn.addEventListener('click', () => {
					checkboxMap.forEach((checkbox) => {
						checkbox.checked = false;
					});
				});

				updateSelectedBtn.addEventListener('click', () => {
					void (async () => {
						const selectedRepos = needsUpdate
							.filter((candidate) => checkboxMap.get(candidate.pluginId)?.checked)
							.map((candidate) => candidate.repo as string);

						if (selectedRepos.length === 0) {
							new Notice('No plugins selected for update.');
							return;
						}

						updateSelectedBtn.disabled = true;
						updateSelectedBtn.innerText = 'Updating...';
						try {
							const { updated, failed } =
								await this.plugin.updatePluginsByRepo(selectedRepos);
							new Notice(
								`Update finished: ${updated} updated${failed > 0 ? `, ${failed} failed` : ''}.`,
							);
							const refreshed = await this.plugin.checkInstalledPluginUpdates();
							renderUpdateCandidates(refreshed);
						} catch (e) {
							const err = e as { message?: string };
							new Notice(
								'Failed to update selected plugins: ' +
									(err.message ?? 'Unknown error'),
							);
							updateSelectedBtn.disabled = false;
							updateSelectedBtn.innerText = 'Update Selected';
						}
					})();
				});
			} else {
				results.createEl('p', { text: 'No newer releases found for resolved plugins.' });
			}

			if (localNewer.length > 0) {
				results.createEl('h5', { text: 'Installed version is newer than latest release' });
				for (const candidate of localNewer) {
					const row = results.createDiv({ cls: 'plugin-result-item' });
					row.createEl('strong', {
						text: `${candidate.pluginId} (Installed ${candidate.currentVersion}, Latest ${candidate.latestVersion || 'unknown'})`,
					});
					row.createEl('div', { text: `${candidate.repo} [${candidate.source}]` });
				}
			}

			if (upToDate.length > 0) {
				results.createEl('h5', { text: 'Up to date' });
				for (const candidate of upToDate) {
					const row = results.createDiv({ cls: 'plugin-result-item' });
					row.createEl('strong', {
						text: `${candidate.pluginId} (${candidate.currentVersion})`,
					});
					row.createEl('div', { text: `${candidate.repo} [${candidate.source}]` });
				}
			}

			if (unknownVersion.length > 0) {
				results.createEl('h5', { text: 'Could not compare versions' });
				for (const candidate of unknownVersion) {
					const row = results.createDiv({ cls: 'plugin-result-item' });
					row.createEl('strong', { text: candidate.pluginId });
					row.createEl('div', { text: `${candidate.repo} [${candidate.source}]` });
					if (candidate.error) {
						row.createEl('p', { text: candidate.error });
					}
				}
			}

			if (unresolved.length > 0) {
				results.createEl('h5', { text: 'Could not resolve repository' });
				for (const candidate of unresolved) {
					const row = results.createDiv({ cls: 'plugin-result-item' });
					row.createEl('strong', { text: candidate.pluginId });
					row.createEl('p', { text: candidate.error || 'Unknown error' });
				}
			}
		};

		const renderRepos = (repos: GithubRepo[]) => {
			results.empty();

			const searchVal = input.value.toLowerCase();
			const isAuthorSearch = searchVal.startsWith('@');
			const authorQuery = isAuthorSearch ? searchVal.slice(1) : '';

			const filteredRepos = repos.filter((repo) => {
				const lowerName = repo.full_name.toLowerCase();
				const lowerDesc = (repo.description || '').toLowerCase();

				const isVault =
					lowerName.includes('/obsidian-vault') ||
					lowerName.endsWith('/vault') ||
					lowerName.includes('-vault') ||
					lowerDesc.includes('my obsidian vault') ||
					lowerDesc.includes('personal vault') ||
					lowerDesc.includes('personal notes') ||
					lowerDesc.includes('my notes') ||
					lowerDesc.includes('sharing my vault');

				if (!searchVal.includes('vault') && isVault) {
					return false;
				}

				if (
					isAuthorSearch ||
					searchVal.includes('theme') ||
					searchVal.includes('css')
				)
					return true;

				const isTheme =
					lowerName.includes('-theme') ||
					lowerName.endsWith('/theme') ||
					lowerName.includes('obsidian-theme') ||
					lowerDesc.includes('theme for obsidian') ||
					lowerDesc.includes('style for obsidian');
				const isCss =
					lowerName.includes('css') ||
					lowerDesc.includes('css snippet') ||
					lowerDesc.includes('custom css') ||
					lowerDesc.includes('visual style');

				return !isTheme && !isCss;
			});

			if (isAuthorSearch) {
				filteredRepos.sort((a, b) => {
					const aOwner = a.owner.login.toLowerCase();
					const bOwner = b.owner.login.toLowerCase();
					const aStarts = aOwner.startsWith(authorQuery) ? 1 : 0;
					const bStarts = bOwner.startsWith(authorQuery) ? 1 : 0;

					if (aStarts !== bStarts) return bStarts - aStarts;
					return b.stargazers_count - a.stargazers_count;
				});
			}

			if (filteredRepos.length === 0) {
				results.createEl('p', { text: 'No plugins found.' });
				return;
			}
			filteredRepos.forEach((repo) => {
				const item = results.createDiv({ cls: 'plugin-result-item' });

				const titleLine = item.createDiv();
				titleLine.createEl('strong', { text: repo.full_name });
				if (repo.stargazers_count > 0) {
					titleLine.createEl('span', {
						text: ` (⭐ ${repo.stargazers_count})`,
						cls: 'stars',
					});
				}

				const descPara = item.createEl('p', { cls: 'description' });
				descPara.createEl('span', { text: repo.description || 'No description' });

				const createBadge = () => {
					descPara.createEl('span', { text: 'Desktop Only', cls: 'desktop-only-badge' });
				};

				if (repo.isDesktopOnly) {
					createBadge();
				} else if (repo.isDesktopOnly === undefined) {
					const repoName = repo.full_name;
					if (DESKTOP_ONLY_CACHE[repoName] !== undefined) {
						if (DESKTOP_ONLY_CACHE[repoName]) createBadge();
					} else {
						const checkManifest = async () => {
							try {
								const manifestUrl = `https://raw.githubusercontent.com/${repoName}/HEAD/manifest.json`;
								const resp = await requestUrl({ url: manifestUrl });
								if (resp.status === 200) {
									const manifest = resp.json as ObsidianManifest | undefined;
									DESKTOP_ONLY_CACHE[repoName] =
										manifest?.isDesktopOnly === true ||
										manifest?.desktopOnly === true;
									if (DESKTOP_ONLY_CACHE[repoName]) {
										createBadge();
									}
								} else {
									DESKTOP_ONLY_CACHE[repoName] = false;
								}
							} catch {
								DESKTOP_ONLY_CACHE[repoName] = false;
							}
						};
						void checkManifest();
					}
				}

				const actions = item.createDiv({ cls: 'actions-row' });

				const viewBtn = actions.createEl('button', { text: 'Read More' });
				viewBtn.addEventListener('click', () => {
					window.open(repo.html_url, '_blank');
				});

				const installBtn = actions.createEl('button', {
					text: 'Install',
					cls: 'mod-cta',
				});

				installBtn.addEventListener('click', () => {
					void (async () => {
						installBtn.disabled = true;
						installBtn.innerText = 'Installing...';
						try {
							await this.plugin.installPluginFromGithub(repo.full_name);
							installBtn.innerText = 'Installed!';
						} catch (e) {
							const err = e as { message?: string };
							installBtn.innerText = 'Failed: ' + (err.message ?? 'Unknown');
							installBtn.disabled = false;
						}
					})();
				});

				const plugin = this.plugin;
				if (plugin.settings.pluginSets.length > 0) {
					const addToSetBtn = actions.createEl('button', { text: 'Add to Set...' });
					addToSetBtn.addEventListener('click', (event: MouseEvent) => {
						const menu = new Menu();
						plugin.settings.pluginSets.forEach((set: PluginSet) => {
							menu.addItem((menuItem) => {
								menuItem
									.setTitle(`Add to "${set.name}"`)
									.setIcon('plus-circle')
									.onClick(() => {
										void (async () => {
											if (!set.plugins.includes(repo.full_name)) {
												set.plugins.push(repo.full_name);
												await plugin.saveSettings();
												new Notice(
													`Added ${repo.full_name} to set "${set.name}"`,
												);
											} else {
												new Notice(
													`${repo.full_name} is already in this set.`,
												);
											}
										})();
									});
							});
						});
						menu.showAtMouseEvent(event);
					});
				}
			});
		};

		const renderUsers = (users: GithubUser[]) => {
			results.empty();
			if (users.length === 0) {
				results.createEl('p', { text: 'No users found.' });
				return;
			}

			results.createEl('h4', { text: 'Select a user to browse their plugins:' });

			const grid = results.createDiv({ cls: 'user-grid eh-user-grid' });

			users.forEach((user) => {
				const card = grid.createDiv({ cls: 'user-card eh-user-card' });

				const img = card.createEl('img');
				img.src = user.avatar_url;

				const userLabel = card.createEl('div', {
					text: user.login,
					cls: 'eh-user-label',
				});
				userLabel.setText(user.login);

				card.addEventListener('click', () => {
					void (async () => {
						const query = `user:${user.login}`;
						results.empty();
						results.createEl('p', { text: `Searching plugins by ${user.login}...` });

						input.value = `@${user.login}`;

						try {
							const plugins = await GithubService.searchPlugins(query, 'updated');
							renderRepos(plugins);
						} catch (e) {
							const err = e as { message?: string };
							results.createEl('p', { text: 'Error: ' + (err.message ?? 'Unknown') });
						}
					})();
				});
			});
		};

		archiveBtn.addEventListener('click', () => {
			void (async () => {
				results.empty();
				results.createEl('p', { text: 'Searching official community archive...' });
				try {
					const repos = await CommunityArchiveService.search(input.value);
					renderRepos(repos);
				} catch (e) {
					const err = e as { message?: string };
					results.createEl('p', {
						text: 'Error searching archive: ' + (err.message ?? 'Unknown'),
					});
				}
			})();
		});

		githubBtn.addEventListener('click', () => {
			void (async () => {
				results.empty();

				try {
					const rawQuery = input.value.trim();

					if (rawQuery.startsWith('@')) {
						results.createEl('p', { text: `Searching users matching "${rawQuery}"...` });
						const name = rawQuery.slice(1);
						const users = await GithubService.searchUsers(name);
						renderUsers(users);
					} else {
						results.createEl('p', { text: `Searching GitHub for: ${input.value}...` });
						const refinedQuery = `${rawQuery} obsidian NOT theme NOT css NOT vault NOT configuration -topic:theme -topic:obsidian-theme`;
						const repos = await GithubService.searchPlugins(refinedQuery, 'stars');
						renderRepos(repos);
					}
				} catch (e) {
					const err = e as { message?: string };
					console.error(e);
					results.empty();
					if (err.message && err.message.includes('403')) {
						const errorLine = results.createEl('p', {
							text: '⚠️ GitHub API Rate Limit Exceeded.',
							cls: 'eh-error-text',
						});
						errorLine.addClass('eh-error-text');
						results.createEl('p', { text: 'Please wait a moment before searching again.' });
					} else {
						results.createEl('p', { text: 'Error searching: ' + (err.message ?? 'Unknown') });
					}
				}
			})();
		});

		forumBtn.addEventListener('click', () => {
			void (async () => {
				results.empty();
				results.createEl('p', { text: `Searching forum for: ${input.value}...` });
				try {
					const topics = await ForumService.search(input.value);
					results.empty();
					if (topics.length === 0) {
						results.createEl('p', { text: 'No forum topics found.' });
						return;
					}
					topics.forEach((topic) => {
						const lowerTitle = topic.title.toLowerCase();
						const searchVal = input.value.toLowerCase();
						const topicTags = topic.tags || [];

						if (
							!searchVal.includes('theme') &&
							!searchVal.includes('css') &&
							!searchVal.includes('snippet')
						) {
							if (topicTags.includes('theme') || topicTags.includes('css')) return;

							const isTheme =
								lowerTitle.includes('theme') && !lowerTitle.includes('plugin');
							const isSnippet =
								lowerTitle.includes('css snippet') || lowerTitle.includes('snippet');

							if (isTheme || isSnippet) return;
						}

						const item = results.createDiv({ cls: 'forum-result-item' });
						item.createEl('strong', { text: topic.title });

						const stats = item.createDiv({ cls: 'topic-stats' });

						const statsParts: string[] = [];
						if (topic.like_count) statsParts.push(`❤️ ${topic.like_count}`);
						if (topic.views) statsParts.push(`👁️ ${topic.views}`);
						if (topic.posts_count) statsParts.push(`💬 ${topic.posts_count}`);
						stats.setText(statsParts.join('  •  '));

						const actions = item.createDiv({ cls: 'actions-row' });
						actions.createEl('button', { text: 'View on Forum' }).addEventListener(
							'click',
							() => {
								window.open(
									`https://forum.obsidian.md/t/${topic.slug}/${topic.id}`,
									'_blank',
								);
							},
						);
					});
				} catch (e) {
					const err = e as { message?: string };
					results.createEl('p', {
						text: 'Error searching forum: ' + (err.message ?? 'Unknown'),
					});
				}
			})();
		});

		checkUpdatesBtn.addEventListener('click', () => {
			void (async () => {
				checkUpdatesBtn.disabled = true;
				const oldText = checkUpdatesBtn.innerText;
				checkUpdatesBtn.innerText = 'Checking...';
				results.empty();
				results.createEl('p', {
					text: 'Checking installed plugins against GitHub releases...',
				});
				try {
					const candidates = await this.plugin.checkInstalledPluginUpdates();
					renderUpdateCandidates(candidates);
				} catch (e) {
					const err = e as { message?: string };
					new Notice('Failed to check plugin updates: ' + (err.message ?? 'Unknown error'));
				} finally {
					checkUpdatesBtn.disabled = false;
					checkUpdatesBtn.innerText = oldText;
				}
			})();
		});
	}
}

class ExtensionHubSettingTab extends PluginSettingTab {
	plugin: ExtensionHub;

	constructor(app: App, plugin: ExtensionHub) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Installation Settings').setHeading();

		new Setting(containerEl)
			.setName('GitHub API Token (optional)')
			.setDesc(
				'Increase GitHub API quota and reduce 403 rate-limit errors. Stored in plugin settings.',
			)
			.addText((text) => {
				text.setPlaceholder('ghp_... or github_pat_...')
					.setValue(this.plugin.settings.githubToken || '')
					.onChange(async (value) => {
						this.plugin.settings.githubToken = value.trim();
						GithubService.setToken(this.plugin.settings.githubToken);
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
				text.inputEl.autocomplete = 'off';
			});

		new Setting(containerEl)
			.setName('Install Location')
			.setDesc('Choose where plugins should be installed by default.')
			.addDropdown((dropdown) =>
				dropdown
					.addOption('active', 'Active Vault')
					.addOption('all', 'All Vaults')
					.addOption('selected', 'Selected Vaults')
					.setValue(this.plugin.settings.installLocation)
					.onChange(async (value) => {
						this.plugin.settings.installLocation = value as
							| 'active'
							| 'all'
							| 'selected';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('All Vaults under parent folder')
			.setDesc('Add absolute paths to folders containing multiple vaults. One path per line.')
			.addTextArea((text: TextAreaComponent) => {
				text.setPlaceholder(
					'e.g. /Users/name/Documents/Obsidian/ or C:\\Vaults\\Obsidian\\',
				)
					.setValue(this.plugin.settings.parentVaultDirectories.join('\n'))
					.onChange(async (value: string) => {
						this.plugin.settings.parentVaultDirectories = value
							.split('\n')
							.filter((p: string) => p.trim() !== '');
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 10;
				text.inputEl.addClass('eh-settings-textarea');
			});

		new Setting(containerEl)
			.setName('Selected Vaults')
			.setDesc('Add absolute paths to other individual vaults. One path per line.')
			.addTextArea((text: TextAreaComponent) => {
				text.setPlaceholder('e.g. /Users/name/Vault or C:\\Vaults\\Vault')
					.setValue(this.plugin.settings.extraVaultPaths.join('\n'))
					.onChange(async (value: string) => {
						this.plugin.settings.extraVaultPaths = value
							.split('\n')
							.filter((p: string) => p.trim() !== '');
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 10;
				text.inputEl.addClass('eh-settings-textarea');
			});

		new Setting(containerEl).setName('Manage Plugin Sets').setHeading();

		const setsContainer = containerEl.createDiv();
		this.renderSets(setsContainer);

		new Setting(containerEl).setName('Create New Set').addButton((btn) =>
			btn
				.setButtonText('Add Set')
				.setCta()
				.onClick(async () => {
					this.plugin.settings.pluginSets.push({ name: 'New Set', plugins: [] });
					await this.plugin.saveSettings();
					this.display();
				}),
		);
	}

	renderSets(container: HTMLElement) {
		this.plugin.settings.pluginSets.forEach((set, index) => {
			const setEl = container.createDiv({ cls: 'eh-set-container' });

			const header = setEl.createDiv({ cls: 'eh-set-header' });

			const nameInput = header.createEl('input', {
				type: 'text',
				value: set.name,
				cls: 'eh-set-name-input',
			});
			nameInput.addEventListener('change', () => {
				void (async () => {
					set.name = nameInput.value;
					await this.plugin.saveSettings();
				})();
			});

			const delBtn = header.createEl('button', {
				text: 'Delete Set',
				cls: 'eh-set-delete-btn',
			});
			delBtn.addEventListener('click', () => {
				void (async () => {
					this.plugin.settings.pluginSets.splice(index, 1);
					await this.plugin.saveSettings();
					this.display();
				})();
			});

			const pluginList = setEl.createDiv({ cls: 'eh-set-plugin-list' });

			if (set.plugins.length === 0) {
				pluginList.setText('No plugins in this set yet. Add them from the Browser.');
			} else {
				set.plugins.forEach((pName, pIndex) => {
					const pRow = pluginList.createDiv({ cls: 'eh-set-plugin-row' });

					pRow.createEl('span', { text: pName });
					const removeBtn = pRow.createEl('button', {
						text: 'Remove',
						cls: 'mod-warning eh-set-remove-btn clickable-icon',
					});
					removeBtn.addEventListener('click', () => {
						void (async () => {
							set.plugins.splice(pIndex, 1);
							await this.plugin.saveSettings();
							this.display();
						})();
					});
				});
			}

			const btnContainer = setEl.createDiv({ cls: 'eh-set-btn-container' });

			const installSetBtn = btnContainer.createEl('button', {
				text: `Install set: ${set.name}`,
				cls: 'mod-cta eh-install-set-btn',
			});
			installSetBtn.addEventListener('click', () => {
				void (async () => {
					installSetBtn.disabled = true;
					installSetBtn.innerText = 'Installing...';
					for (const fullName of set.plugins) {
						try {
							await this.plugin.installPluginFromGithub(fullName);
						} catch (e) {
							console.error(`Failed to install ${fullName}:`, e);
						}
					}
					installSetBtn.innerText = 'Done!';
					window.setTimeout(() => {
						installSetBtn.disabled = false;
						installSetBtn.innerText = `Install set: ${set.name}`;
					}, 3000);
				})();
			});
		});
	}
}
