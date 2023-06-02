'use strict';

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LogLevel, TimeStampedLogger } from './logging';

interface Needs {
	[need_id: string]: Need;
}

interface Need {
	id: string;
	description: string;
	docname: string;
	doctype: string;
	status: string;
	title: string;
	type: string;
	parent_need: string;
}

interface SNVConfig {
	needsJson: string | undefined;
	srcDir: string | undefined;
	folders: DocConf[];
	explorerOptions: string[] | undefined;
	explorerItemHoverOptions: string[] | undefined;
	loggingLevel: LogLevel;
}

interface DocConf {
	needsJson: string;
	srcDir: string;
}

interface NeedsInfo {
	needs: Needs;
	allFiles: string[];
	src_dir: string;
	needs_json: string;
}

interface NeedsInfos {
	[path: string]: NeedsInfo | undefined;
}

let tslogger: TimeStampedLogger;

export class NeedsExplorerProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<NeedTree[] | undefined> = new vscode.EventEmitter<
		NeedTree[] | undefined
	>();
	readonly onDidChangeTreeData: vscode.Event<NeedTree[] | undefined> = this._onDidChangeTreeData.event;

	needsInfo: NeedsInfo = {
		needs: {},
		allFiles: [],
		src_dir: '',
		needs_json: ''
	};
	snvConfigs: SNVConfig;
	needsInfos: NeedsInfos = {};
	isMultiDocs = false;

	constructor() {
		// Get workspace configurations and init snvConfigs
		this.snvConfigs = this.getSNVConfigurations();

		// Initial logger
		tslogger = new TimeStampedLogger(this.snvConfigs.loggingLevel);

		tslogger.info("SNV Explorer -> constructor");

		// Check needsJson and srcDir from workspace configurations
		this.check_wk_configs();
		tslogger.info("SNV Explorer -> checked configs");

		// Load all needsJsons from workspace configurations
		this.needsInfos = this.loadAllNeedsJsonsToInfos();

		// Only watch active editor change to update tree view when is multi docs
		vscode.window.onDidChangeActiveTextEditor(() => this.onActiveEditorChanged());

		// Create file watcher for needs.json
		this.watcher();

		// Listen to workspace configuration change event
		this.listenToChangeConfiguration();
	}

	openNeedsJson(): void {
		// Open needsJson
		const need_json_path = this.needsInfo.needs_json;
		if (need_json_path && this.pathExists(need_json_path)) {
			vscode.window.showTextDocument(vscode.Uri.file(need_json_path));
		}
	}

	openSettings(): void {
		// Open Settings of this extension
		vscode.commands.executeCommand('workbench.action.openSettings', 'sphinx-needs');
	}

	openSphinxNeedsOfficialDocs(): void {
		// Open Sphinx-Needs official docs in default external browser
		// vscode.env.openExternal(vscode.Uri.parse('https://sphinx-needs.readthedocs.io/en/latest/index.html'));

		// Open Sphinx-Needs official docs in internal simple browser inside vscode
		vscode.commands.executeCommand(
			'simpleBrowser.api.open',
			'https://sphinx-needs.readthedocs.io/en/latest/index.html'
		);
	}

	goToDefinition(item: NeedTree): void {
		vscode.workspace.openTextDocument(item.idLoc.uri).then((doc) => {
			vscode.window.showTextDocument(doc).then((editor) => {
				editor.selections = [new vscode.Selection(item.idLoc.range.start, item.idLoc.range.end)];
				editor.revealRange(item.idLoc.range, vscode.TextEditorRevealType.Default);
			});
		});
	}

	copyNeedID(item: NeedTree): void {
		vscode.env.clipboard.writeText(item.id);
	}

	private watcher(): void {
		// Create file watcher for all relevant needs json files
		const all_curr_needs_jsons = Object.keys(this.needsInfos);
		const watcher = vscode.workspace.createFileSystemWatcher('**/*.json');
		// Watch for file content change
		watcher.onDidChange((uri) => {
			tslogger.info(`SVN Explorer -> File change: ${uri}`)
			if (all_curr_needs_jsons.indexOf(uri.fsPath) >= 0) {
				this.needsInfos[uri.fsPath] = this.loadNeedsJsonToInfo(uri.fsPath);
				this._onDidChangeTreeData.fire(undefined);
			}
		});
		// Watch for file create
		watcher.onDidCreate((uri) => {
			tslogger.info(`SVN Explorer -> File creation: ${uri}`)
			if (all_curr_needs_jsons.indexOf(uri.fsPath) >= 0) {
				this.needsInfos[uri.fsPath] = this.loadNeedsJsonToInfo(uri.fsPath);
				this._onDidChangeTreeData.fire(undefined);
			}
		});
	}

	private onActiveEditorChanged(): void {
		if (this.isMultiDocs && vscode.window.activeTextEditor) {
			const curr_doc = vscode.window.activeTextEditor.document.uri.fsPath;
			Object.values(this.needsInfos).forEach((need_info) => {
				if (need_info?.allFiles && need_info?.allFiles.indexOf(curr_doc) >= 0) {
					this.needsInfo = need_info;
					this._onDidChangeTreeData.fire(undefined);
				}
			});
		}
	}

	private listenToChangeConfiguration(): void {
		vscode.workspace.onDidChangeConfiguration(() => {
			tslogger.info(`SVN Explorer -> Configuration change`)
			let updateTreeData = false;
			const newConfig = this.getSNVConfigurations();

			// Check if loggingLevel changed
			if (this.snvConfigs.loggingLevel !== newConfig.loggingLevel) {
				this.snvConfigs.loggingLevel = newConfig.loggingLevel;
				tslogger = new TimeStampedLogger(this.snvConfigs.loggingLevel);
			}

			// Check if explorerOptions changed
			if (this.snvConfigs.explorerOptions !== newConfig.explorerOptions) {
				this.snvConfigs.explorerOptions = newConfig.explorerOptions;
				updateTreeData = true;
			}

			// Check if explorerItemHoverOptions changed
			if (this.snvConfigs.explorerItemHoverOptions !== newConfig.explorerItemHoverOptions) {
				this.snvConfigs.explorerItemHoverOptions = newConfig.explorerItemHoverOptions;
				updateTreeData = true;
			}

			let reloadNeedsJson = false;
			// Check if needsJson path got changed
			if (this.snvConfigs.needsJson !== newConfig.needsJson) {
				this.snvConfigs.needsJson = newConfig.needsJson;
				reloadNeedsJson = true;
				updateTreeData = true;
				// Update watcher for new needs.json
				this.watcher();
			}

			// Check if srcDir changed
			if (this.snvConfigs.srcDir !== newConfig.srcDir) {
				this.snvConfigs.srcDir = newConfig.srcDir;
				reloadNeedsJson = true;
				updateTreeData = true;
			}

			// Check if folders changed
			if (this.snvConfigs.folders !== newConfig.folders) {
				this.snvConfigs.folders = newConfig.folders;
				reloadNeedsJson = true;
				updateTreeData = true;
			}

			// Check configurations and isMultiDocs
			this.check_wk_configs();
			if (!this.isMultiDocs) {
				updateTreeData = true;
			}

			// Update tree data
			if (updateTreeData) {
				// Reload needsJson to needs infos
				if (reloadNeedsJson) {
					this.needsInfos = this.loadAllNeedsJsonsToInfos();
					// If empty needsInfos, then update needsInfo
					if (Object.keys(this.needsInfos).length <= 0) {
						this.needsInfo = {
							needs: {},
							allFiles: [],
							src_dir: '',
							needs_json: ''
						};
					}
				}
				this._onDidChangeTreeData.fire(undefined);
			}
		});
	}

	getChildren(element?: NeedTree | NeedOptionItem): Thenable<vscode.TreeItem[]> {
		tslogger.info(`SNV NeedsExplorerProvider -> getChildren(${element?.id} = ${element?.label})`);
		if (!this.needsInfo.needs) {
			tslogger.info(`SNV NeedsExplorerProvider -> getChildren: No needs!`);
			return Promise.resolve([]);
		}

		if (!element) {
			// Root level
			tslogger.info(`SNV NeedsExplorerProvider -> getChildren: root`);
			return Promise.resolve(this.getNeedTree());
		}

		// Get and show need options
		if (element.id && element.id in this.needsInfo.needs && this.snvConfigs.explorerOptions) {
			const optionItems: NeedOptionItem[] = [];
			this.snvConfigs.explorerOptions.forEach((option) => {
				tslogger.info(`SNV NeedsExplorerProvider -> getChildren: option ${option} for ${element.id}`);
				if (element.id) {
					// check if option exists in needs.json
					if (option in this.needsInfo.needs[element.id]) {
						for (const [need_option, op_value] of Object.entries(this.needsInfo.needs[element.id])) {
							if (option === need_option) {
								tslogger.info(`SNV NeedsExplorerProvider -> getChildren: option ${option} for ${element.id} == ${op_value}`);
								optionItems.push(
									new NeedOptionItem(option + ': ' + op_value, vscode.TreeItemCollapsibleState.None)
								);
							}
						}
					} else {
						optionItems.push(new NeedOptionItem(option + ': None', vscode.TreeItemCollapsibleState.None));
						tslogger.warn(`SNV Explorer -> Need option ${option} not exists for ${element.id}.`);
					}
				}
			});
			return Promise.resolve(optionItems);
		}
		return Promise.resolve([]);
	}

	getTreeItem(element: NeedTree): vscode.TreeItem | Thenable<vscode.TreeItem> {
		tslogger.info(`SNV NeedsExplorerProvider -> getTreeItem(${element}))`);
		return element;
	}

	private getSNVConfigurations(): SNVConfig {
		// Get relevant configuration settings
		let needs_json_path: string | undefined = vscode.workspace.getConfiguration('sphinx-needs').get('needsJson');
		let confPyDir: string | undefined = vscode.workspace.getConfiguration('sphinx-needs').get('srcDir');
		const wk_folders: DocConf[] | undefined = vscode.workspace.getConfiguration('sphinx-needs').get('folders');
		const shownNeedOptions: string[] | undefined = vscode.workspace
			.getConfiguration('sphinx-needs')
			.get('explorerOptions');
		const hoverNeedOptions: string[] | undefined = vscode.workspace
			.getConfiguration('sphinx-needs')
			.get('explorerItemHoverOptions');
		let logLevel: LogLevel | undefined = vscode.workspace.getConfiguration('sphinx-needs').get('loggingLevel');
		if (!logLevel) {
			logLevel = 'warn';
		}

		// Replace ${workspaceFolder} from the configurations if needed
		const workspaceFolderpath =
			vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
				? vscode.workspace.workspaceFolders[0].uri.fsPath
				: undefined;
		console.info(`SNV Explorer -> vscode.workspace.workspaceFolders: ${vscode.workspace.workspaceFolders}`);
		const conf_folders: DocConf[] = [];
		if (workspaceFolderpath) {
			if (vscode.workspace.workspaceFolders) {
				let folder0 = vscode.workspace.workspaceFolders[0]
				console.info(`SNV Explorer -> vscode.workspace.workspaceFolders[0]: ${folder0}`);
				console.info(`SNV Explorer -> vscode.workspace.workspaceFolders[0].uri: ${folder0.uri}`);	
			}
			needs_json_path = needs_json_path?.replace('${workspaceFolder}', workspaceFolderpath);
			confPyDir = confPyDir?.replace('${workspaceFolder}', workspaceFolderpath);
			wk_folders?.forEach((folder) => {
				conf_folders.push({
					needsJson: folder.needsJson.replace('${workspaceFolder}', workspaceFolderpath),
					srcDir: folder.srcDir.replace('${workspaceFolder}', workspaceFolderpath)
				});
			});
			console.info(`SNV Explorer -> replaced workspaceFolder path: ${workspaceFolderpath}`);
		} else {
			console.error(`SNV Explorer -> Can't resolve current workspaceFolder path: ${workspaceFolderpath}`);
		}

		return {
			needsJson: needs_json_path,
			srcDir: confPyDir,
			folders: conf_folders,
			explorerOptions: shownNeedOptions,
			explorerItemHoverOptions: hoverNeedOptions,
			loggingLevel: logLevel
		};
	}

	private check_wk_configs() {
		// Check if path exists of needsJson and srcDir
		if (!this.snvConfigs.needsJson) {
			tslogger.warn(`SNV Explorer -> needsJson path not exists: ${this.snvConfigs.needsJson}`);
		} else if (!this.pathExists(this.snvConfigs.needsJson)) {
			tslogger.error(
				`SNV Explorer -> given sphinx-needs.needsJson path not exists: ${this.snvConfigs.needsJson}`
			);
		}

		if (!this.snvConfigs.srcDir) {
			tslogger.warn('SNV Explorer -> sphinx-needs.srcDir is empty or undefined');
		} else if (!this.pathExists(this.snvConfigs.srcDir)) {
			tslogger.error(`SNV Explorer -> given sphinx-needs.srcDir path not exists: ${this.snvConfigs.srcDir}`);
		}

		// Check if path of needsJson and srcDir from sphinx-needs.folders exist
		if (this.snvConfigs.folders.length <= 0) {
			this.isMultiDocs = false;
		} else {
			this.snvConfigs.folders.forEach((fd) => {
				if (!fd.needsJson) {
					tslogger.warn('SNV Explorer -> needsJson empty or undefined in sphinx-needs.folders');
				} else if (!this.pathExists(fd.needsJson)) {
					tslogger.error(
						`SNV Explorer -> needsJson path in sphinx-needs.folders not exists: ${fd.needsJson}`
					);
				}
				if (!fd.srcDir) {
					tslogger.warn('SNV Explorer -> srcDir empty or undefined in sphinx-needs.folders');
				} else if (!this.pathExists(fd.srcDir)) {
					tslogger.error(`SNV Explorer -> srcDir path in sphinx-needs.folders not exists: ${fd.srcDir}`);
				}
			});
			this.isMultiDocs = true;
		}
	}

	private loadAllNeedsJsonsToInfos(): NeedsInfos {
		tslogger.info('SNV Explorer -> Loading needs JSON');
		const all_needs_infos: NeedsInfos = {};
		// Load needsJson from sphinx-needs.folders
		this.snvConfigs.folders.forEach((fd) => {
			if (!(fd.needsJson in all_needs_infos)) {
				all_needs_infos[fd.needsJson] = this.loadNeedsJsonToInfo(fd.needsJson);
			} else {
				tslogger.warn('SNV Explorer -> Duplicate needsJson config in sphinx-needs.folders');
			}
		});
		// Load sphinx-needs.needsJson
		if (this.snvConfigs.needsJson && this.snvConfigs.srcDir && !(this.snvConfigs.needsJson in all_needs_infos)) {
			tslogger.info(`SNV Explorer -> Loading sphinx-needs.needsJson from ${this.snvConfigs.needsJson}`);
			all_needs_infos[this.snvConfigs.needsJson] = this.loadNeedsJsonToInfo(this.snvConfigs.needsJson);
		}
		return all_needs_infos;
	}

	private loadNeedsJsonToInfo(needsJsonFilePath: string | undefined): NeedsInfo | undefined {
		// Check needs.json path and get needs object from needs.json if exists
		tslogger.info(`SNV Explorer -> loadNeedsJsonToInfo: ${needsJsonFilePath}`);
		if (needsJsonFilePath && this.pathExists(needsJsonFilePath)) {
			tslogger.debug(`SNV Explorer -> Loading needs json: ${needsJsonFilePath}`);

			// Read needs.json
			const needsJson = JSON.parse(fs.readFileSync(needsJsonFilePath, 'utf-8'));
			tslogger.debug(`SNV Explorer -> Loaded needs json: ${JSON.stringify(needsJson)}`);

			// Get needs objects from current_version
			const curr_version: string = needsJson['current_version'];
			const needs_objects: Needs = needsJson['versions'][curr_version]['needs'];

			// Check and get doctype for nested child needs
			for (const need of Object.values(needs_objects)) {
				let temp_parent_id: string;
				let temp_parent: Need;
				// Get child need
				if (!need['doctype'] && need['parent_need']) {
					// search up to top parent need to get info of doctype
					temp_parent_id = need['parent_need'];
					temp_parent = needs_objects[temp_parent_id];
					while (temp_parent['parent_need']) {
						if (!temp_parent['parent_need']) {
							break;
						}
						temp_parent = needs_objects[temp_parent['parent_need']];
					}
					need['doctype'] = temp_parent['doctype'];
				}
			}

			// Get current srcDir
			let curr_src_dir = '';
			if (this.snvConfigs.needsJson === needsJsonFilePath) {
				if (this.snvConfigs.srcDir) {
					curr_src_dir = this.snvConfigs.srcDir;
				}
			} else {
				this.snvConfigs.folders?.forEach((fd) => {
					if (fd.needsJson === needsJsonFilePath) {
						curr_src_dir = fd.srcDir;
					}
				});
			}

			// Calculate all files paths in current srcDir
			const all_files_path: string[] = [];
			let need_doc_path: string;
			Object.values(needs_objects).forEach((nd) => {
				if (curr_src_dir.endsWith('/')) {
					need_doc_path = curr_src_dir + nd.docname + nd.doctype;
				} else {
					need_doc_path = curr_src_dir + '/' + nd.docname + nd.doctype;
				}

				if (all_files_path.indexOf(need_doc_path) === -1) {
					all_files_path.push(need_doc_path);
				}
			});

			const needs_info: NeedsInfo = {
				needs: needs_objects,
				allFiles: all_files_path,
				src_dir: curr_src_dir,
				needs_json: needsJsonFilePath
			};
			return needs_info;
		}
	}

	private getNeedFilePath(need: Need): vscode.Uri {
		// Get file path of current need
		const curr_need: Need = this.needsInfo.needs[need.id];

		// Check if docname and doctype exist in need object
		if (!('docname' in curr_need)) {
			tslogger.warn(`SNV Explorer -> Option docname not exists in Need ${curr_need}`);
			return vscode.Uri.file('');
		}
		if (!('doctype' in curr_need)) {
			tslogger.warn(`SNV Explorer -> Option doctype not exists in Need ${curr_need}`);
			return vscode.Uri.file('');
		}

		// Calculate doc path uri for current need
		let curr_need_file_path = '';
		if (this.needsInfo.src_dir) {
			curr_need_file_path = path.resolve(this.needsInfo.src_dir, curr_need.docname + curr_need.doctype);
			tslogger.warn(`SNV Explorer -> doc path for Need ${need.id} is ${curr_need_file_path}`);
			if (!this.pathExists(curr_need_file_path)) {
				tslogger.warn(`SNV Explorer -> doc path for Need ${need.id} not exists: ${curr_need_file_path}`);
			}
		}
		const needFileUri: vscode.Uri = vscode.Uri.file(curr_need_file_path);
		tslogger.warn(`SNV Explorer -> neddFileUri for Need ${need.id} is ${needFileUri}`);
		return needFileUri;
	}

	private getNeedTree(): NeedTree[] {
		const needsItems: NeedTree[] = [];
		tslogger.info(`SNV NeedsExplorerProvider -> getNeedTree`);
		if (this.needsInfo.needs) {
			Object.values(this.needsInfo.needs).forEach((need) => {
				tslogger.info(`SNV NeedsExplorerProvider -> getNeedTree: processing ${need.id}`);
				// Check if Need ID matches Need Objects key entry
				if (!(need['id'] in this.needsInfo.needs)) {
					tslogger.warn(`SNV Explorer -> Need object entry of ${need.id} not exits in given needs.json`);
				} else {
					// Calculate needed hoverOptionsValues for hover over item
					const hoverOptionValues: string[] = [];
					this.snvConfigs.explorerItemHoverOptions?.forEach((op) => {
						if (!(op in need)) {
							tslogger.warn(`SNV Explorer -> given need option ${op} not exists.`);
						} else {
							for (const [key, value] of Object.entries(need)) {
								if (op === key && value && value.length) {
									hoverOptionValues.push(op + ': ' + value);
								}
							}
						}
					});
					// Get need ID Definition Location
					const needFileUri = this.getNeedFilePath(need);
					tslogger.info(`SNV NeedsExplorerProvider -> getNeedTree: needFileUri for ${need.id} = ${needFileUri}`);
					let needIDPos;
					try {
						needIDPos = findDefinition(need, needFileUri);
					} catch (err) {
						tslogger.error(`SNV Explorer -> No Need ID defintion found for ${need['id']}.`);
					}
					if (!needIDPos) {
						needIDPos = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
					}
					const needIDLoc = new vscode.Location(needFileUri, needIDPos);

					const needItem = new NeedTree(
						need['id'],
						need['title'],
						need['description'],
						hoverOptionValues,
						needIDLoc,
						vscode.TreeItemCollapsibleState.Collapsed
					);
					needsItems.push(needItem);
				}
			});
			return needsItems;
		} else {
			tslogger.info(`SNV NeedsExplorerProvider -> getNeedTree: no needs!`);
			return [];
		}
	}

	private pathExists(p: string): boolean {
		try {
			fs.accessSync(p);
		} catch (err) {
			return false;
		}
		return true;
	}
}

class NeedTree extends vscode.TreeItem {
	constructor(
		public readonly id: string,
		private title: string,
		private content: string,
		private hoverOptions: string[],
		public readonly idLoc: vscode.Location,
		public readonly collapsibleState: vscode.TreeItemCollapsibleState
	) {
		super(id, collapsibleState);
		let hoverContents = `**${this.title}**\n\n\`\`\`\n${this.content}\n\`\`\`\n\n`;
		if (this.hoverOptions) {
			this.hoverOptions.forEach((op) => {
				hoverContents = hoverContents.concat(
					`&nbsp;<span style="color:#ffffff;background-color:#0078d4;">&nbsp;&nbsp;${op}&nbsp;&nbsp;</span>&nbsp;`
				);
			});
		}
		this.tooltip = new vscode.MarkdownString(hoverContents, true);
		this.tooltip.supportHtml = true;
		this.description = this.title;
	}

	contextValue = 'needID';
}

class NeedOptionItem extends vscode.TreeItem {
	constructor(private option: string, collapsibleState: vscode.TreeItemCollapsibleState) {
		super(option, collapsibleState);
		this.tooltip = new vscode.MarkdownString(`${this.option}`, true);
	}
}

function findDefinition(need: Need, fileUri: vscode.Uri): vscode.Range | undefined {
	// Return definition location of given Need ID

	// Read the document where Need ID is at
	const doc_contents = read_need_doc_contents(fileUri);
	if (!doc_contents) {
		tslogger.info(`SNV NeedsExplorerProvider -> findDefinition: failed to read ${fileUri} for ${need.id}`);
		return;
	}

	// Get location of need directive definition line index, e.g. .. req::
	const need_directive_location = find_directive_definition(doc_contents, need);
	if (!need_directive_location) {
		tslogger.info(`SNV NeedsExplorerProvider -> findDefinition: failed to find directive in ${fileUri} for ${need.id}`);
		return;
	}

	const startIdxID = doc_contents[need_directive_location + 1].indexOf(need['id']);
	const endIdxID = startIdxID + need['id'].length;
	const startPos = new vscode.Position(need_directive_location + 1, startIdxID);
	const endPos = new vscode.Position(need_directive_location + 1, endIdxID);

	return new vscode.Range(startPos, endPos);
}

function read_need_doc_contents(fileUri: vscode.Uri): string[] | null {
	try {
		const doc_content: string = fs.readFileSync(fileUri.fsPath, 'utf8');
		const doc_content_lines = doc_content.split('\n');
		return doc_content_lines;
	} catch (err) {
		tslogger.error(`SNV Explorer -> Error read docoment: ${err}`);
	}
	return null;
}

function find_directive_definition(doc_content_lines: string[], curr_need: Need): number | null {
	// Get line of need id definition with pattern {:id: need_id}
	const id_pattern = `:id: ${curr_need.id}`;
	// Check if id_pattern exists in target document
	if (
		doc_content_lines.every((line) => {
			line.indexOf(id_pattern) !== -1;
		})
	) {
		tslogger.error(`SNV Explorer -> No defintion found of ${curr_need.id}.`);
		return null;
	}
	const found_id_line_idx = doc_content_lines.findIndex((line) => line.indexOf(id_pattern) !== -1);

	// Get line of directive with pattern {.. {need_type}::}
	const directive_pattern = `.. ${curr_need.type}::`;
	// Get lines before id_line_idx to find the line of directive
	const new_doc_content_lines = doc_content_lines.slice(0, found_id_line_idx);
	// Check if direcrive_pattern exists in target document
	if (
		new_doc_content_lines.every((line) => {
			line.indexOf(directive_pattern) !== -1;
		})
	) {
		tslogger.error(`SNV Explorer -> No defintion found of ${curr_need.id}.`);
		return null;
	}
	const found_reverse_directive_line_idx = new_doc_content_lines
		.reverse()
		.findIndex((line) => line.indexOf(directive_pattern) !== -1);
	const found_directive_line_idx = new_doc_content_lines.length - 1 - found_reverse_directive_line_idx;
	return found_directive_line_idx;
}
