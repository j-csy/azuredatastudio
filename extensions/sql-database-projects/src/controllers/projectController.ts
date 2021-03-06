/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as constants from '../common/constants';
import * as dataSources from '../models/dataSources/dataSources';
import * as mssql from '../../../mssql';
import * as os from 'os';
import * as path from 'path';
import * as utils from '../common/utils';
import * as UUID from 'vscode-languageclient/lib/utils/uuid';
import * as templates from '../templates/templates';
import * as xmldom from 'xmldom';

import { Uri, QuickPickItem, WorkspaceFolder, extensions, Extension } from 'vscode';
import { IConnectionProfile, TaskExecutionMode } from 'azdata';
import { promises as fs } from 'fs';
import { ApiWrapper } from '../common/apiWrapper';
import { PublishDatabaseDialog } from '../dialogs/publishDatabaseDialog';
import { Project, DatabaseReferenceLocation, SystemDatabase, TargetPlatform, ProjectEntry, reservedProjectFolders } from '../models/project';
import { SqlDatabaseProjectTreeViewProvider } from './databaseProjectTreeViewProvider';
import { FolderNode, FileNode } from '../models/tree/fileFolderTreeItem';
import { IPublishSettings, IGenerateScriptSettings, PublishProfile } from '../models/IPublishSettings';
import { BaseProjectTreeItem } from '../models/tree/baseTreeItem';
import { ProjectRootTreeItem } from '../models/tree/projectTreeItem';
import { ImportDataModel } from '../models/api/import';
import { NetCoreTool, DotNetCommandOptions } from '../tools/netcoreTool';
import { BuildHelper } from '../tools/buildHelper';

/**
 * Controller for managing project lifecycle
 */
export class ProjectsController {
	private projectTreeViewProvider: SqlDatabaseProjectTreeViewProvider;
	private netCoreTool: NetCoreTool;
	private buildHelper: BuildHelper;

	projects: Project[] = [];

	constructor(private apiWrapper: ApiWrapper, projTreeViewProvider: SqlDatabaseProjectTreeViewProvider) {
		this.projectTreeViewProvider = projTreeViewProvider;
		this.netCoreTool = new NetCoreTool();
		this.buildHelper = new BuildHelper();
	}

	public refreshProjectsTree() {
		this.projectTreeViewProvider.load(this.projects);
	}

	public async openProject(projectFile: Uri): Promise<Project> {
		for (const proj of this.projects) {
			if (proj.projectFilePath === projectFile.fsPath) {
				this.apiWrapper.showInformationMessage(constants.projectAlreadyOpened(projectFile.fsPath));
				return proj;
			}
		}

		const newProject = new Project(projectFile.fsPath);

		try {
			// Read project file
			await newProject.readProjFile();
			this.projects.push(newProject);

			// Update for round tripping as needed
			await this.updateProjectForRoundTrip(newProject);

			// Read datasources.json (if present)
			const dataSourcesFilePath = path.join(path.dirname(projectFile.fsPath), constants.dataSourcesFileName);

			newProject.dataSources = await dataSources.load(dataSourcesFilePath);
		}
		catch (err) {
			if (err instanceof dataSources.NoDataSourcesFileError) {
				// TODO: prompt to create new datasources.json; for now, swallow
			}
			else {
				this.projects = this.projects.filter((e) => { return e !== newProject; });
				throw err;
			}
		}

		try {
			this.refreshProjectsTree();
			await this.focusProject(newProject);
		}
		catch (err) {
			// if the project didnt load - remove it from the list of open projects
			this.projects = this.projects.filter((e) => { return e !== newProject; });
			throw err;
		}

		return newProject;
	}

	public async focusProject(project?: Project): Promise<void> {
		if (project && this.projects.includes(project)) {
			await this.apiWrapper.executeCommand(constants.sqlDatabaseProjectsViewFocusCommand);
			await this.projectTreeViewProvider.focus(project);
		}
	}

	/**
	 * Creates a new folder with the project name in the specified location, and places the new .sqlproj inside it
	 * @param newProjName
	 * @param folderUri
	 * @param projectGuid
	 */
	public async createNewProject(newProjName: string, folderUri: Uri, makeOwnFolder: boolean, projectGuid?: string): Promise<string> {
		if (projectGuid && !UUID.isUUID(projectGuid)) {
			throw new Error(`Specified GUID is invalid: '${projectGuid}'`);
		}

		const macroDict: Record<string, string> = {
			'PROJECT_NAME': newProjName,
			'PROJECT_GUID': projectGuid ?? UUID.generateUuid().toUpperCase()
		};

		let newProjFileContents = this.macroExpansion(templates.newSqlProjectTemplate, macroDict);

		let newProjFileName = newProjName;

		if (!newProjFileName.toLowerCase().endsWith(constants.sqlprojExtension)) {
			newProjFileName += constants.sqlprojExtension;
		}

		const newProjFilePath = makeOwnFolder ? path.join(folderUri.fsPath, path.parse(newProjFileName).name, newProjFileName) : path.join(folderUri.fsPath, newProjFileName);

		let fileExists = false;
		try {
			await fs.access(newProjFilePath);
			fileExists = true;
		}
		catch { } // file doesn't already exist

		if (fileExists) {
			throw new Error(constants.projectAlreadyExists(newProjFileName, folderUri.fsPath));
		}

		await fs.mkdir(path.dirname(newProjFilePath), { recursive: true });
		await fs.writeFile(newProjFilePath, newProjFileContents);

		return newProjFilePath;
	}

	public closeProject(treeNode: BaseProjectTreeItem) {
		const project = this.getProjectFromContext(treeNode);
		this.projects = this.projects.filter((e) => { return e !== project; });
		this.refreshProjectsTree();
	}

	/**
	 * Builds a project, producing a dacpac
	 * @param treeNode a treeItem in a project's hierarchy, to be used to obtain a Project
	 * @returns path of the built dacpac
	 */
	public async buildProject(treeNode: BaseProjectTreeItem): Promise<string>;
	/**
	 * Builds a project, producing a dacpac
	 * @param project Project to be built
	 * @returns path of the built dacpac
	 */
	public async buildProject(project: Project): Promise<string>;
	public async buildProject(context: Project | BaseProjectTreeItem): Promise<string | undefined> {
		const project: Project = this.getProjectFromContext(context);

		// Check mssql extension for project dlls (tracking issue #10273)
		await this.buildHelper.createBuildDirFolder();

		const options: DotNetCommandOptions = {
			commandTitle: 'Build',
			workingDirectory: project.projectFolderPath,
			argument: this.buildHelper.constructBuildArguments(project.projectFilePath, this.buildHelper.extensionBuildDirPath)
		};
		try {
			await this.netCoreTool.runDotnetCommand(options);

			return path.join(project.projectFolderPath, 'bin', 'Debug', `${project.projectFileName}.dacpac`);
		}
		catch (err) {
			this.apiWrapper.showErrorMessage(constants.projBuildFailed(utils.getErrorMessage(err)));
			return undefined;
		}
	}

	/**
	 * Builds and publishes a project
	 * @param treeNode a treeItem in a project's hierarchy, to be used to obtain a Project
	 */
	public publishProject(treeNode: BaseProjectTreeItem): PublishDatabaseDialog;
	/**
	 * Builds and publishes a project
	 * @param project Project to be built and published
	 */
	public publishProject(project: Project): PublishDatabaseDialog;
	public publishProject(context: Project | BaseProjectTreeItem): PublishDatabaseDialog {
		const project: Project = this.getProjectFromContext(context);
		let publishDatabaseDialog = this.getPublishDialog(project);

		publishDatabaseDialog.publish = async (proj, prof) => await this.executionCallback(proj, prof);
		publishDatabaseDialog.generateScript = async (proj, prof) => await this.executionCallback(proj, prof);
		publishDatabaseDialog.readPublishProfile = async (profileUri) => await this.readPublishProfile(profileUri);

		publishDatabaseDialog.openDialog();

		return publishDatabaseDialog;
	}

	public async executionCallback(project: Project, settings: IPublishSettings | IGenerateScriptSettings): Promise<mssql.DacFxResult | undefined> {
		const dacpacPath = await this.buildProject(project);

		if (!dacpacPath) {
			return undefined; // buildProject() handles displaying the error
		}

		// copy dacpac to temp location before publishing
		const tempPath = path.join(os.tmpdir(), `${path.parse(dacpacPath).name}_${new Date().getTime()}${constants.sqlprojExtension}`);
		await fs.copyFile(dacpacPath, tempPath);

		const dacFxService = await this.getDaxFxService();

		if ((<IPublishSettings>settings).upgradeExisting) {
			return await dacFxService.deployDacpac(tempPath, settings.databaseName, (<IPublishSettings>settings).upgradeExisting, settings.connectionUri, TaskExecutionMode.execute, settings.sqlCmdVariables);
		}
		else {
			return await dacFxService.generateDeployScript(tempPath, settings.databaseName, settings.connectionUri, TaskExecutionMode.script, settings.sqlCmdVariables);
		}
	}

	public async readPublishProfile(profileUri: Uri): Promise<PublishProfile> {
		const profileText = await fs.readFile(profileUri.fsPath);
		const profileXmlDoc = new xmldom.DOMParser().parseFromString(profileText.toString());

		// read target database name
		let targetDbName: string = '';
		let targetDatabaseNameCount = profileXmlDoc.documentElement.getElementsByTagName(constants.targetDatabaseName).length;
		if (targetDatabaseNameCount > 0) {
			// if there is more than one TargetDatabaseName nodes, SSDT uses the name in the last one so we'll do the same here
			targetDbName = profileXmlDoc.documentElement.getElementsByTagName(constants.targetDatabaseName)[targetDatabaseNameCount - 1].textContent;
		}

		// get all SQLCMD variables to include from the profile
		let sqlCmdVariables = utils.readSqlCmdVariables(profileXmlDoc);

		return {
			databaseName: targetDbName,
			sqlCmdVariables: sqlCmdVariables
		};
	}

	public async schemaCompare(treeNode: BaseProjectTreeItem): Promise<void> {
		// check if schema compare extension is installed
		if (this.apiWrapper.getExtension(constants.schemaCompareExtensionId)) {
			// build project
			await this.buildProject(treeNode);

			// start schema compare with the dacpac produced from build
			const project = this.getProjectFromContext(treeNode);
			const dacpacPath = path.join(project.projectFolderPath, 'bin', 'Debug', `${project.projectFileName}.dacpac`);

			// check that dacpac exists
			if (await utils.exists(dacpacPath)) {
				await this.apiWrapper.executeCommand(constants.schemaCompareStartCommand, dacpacPath);
			} else {
				this.apiWrapper.showErrorMessage(constants.buildDacpacNotFound);
			}
		} else {
			this.apiWrapper.showErrorMessage(constants.schemaCompareNotInstalled);
		}
	}

	public async addFolderPrompt(treeNode: BaseProjectTreeItem) {
		const project = this.getProjectFromContext(treeNode);
		const newFolderName = await this.promptForNewObjectName(new templates.ProjectScriptType(templates.folder, constants.folderFriendlyName, ''), project);

		if (!newFolderName) {
			return; // user cancelled
		}

		const relativeFolderPath = path.join(this.getRelativePath(treeNode), newFolderName);

		try {
			// check if folder already exists or is a reserved folder
			const absoluteFolderPath = path.join(project.projectFolderPath, relativeFolderPath);
			const folderExists = await utils.exists(absoluteFolderPath);

			if (folderExists || this.isReservedFolder(absoluteFolderPath, project.projectFolderPath)) {
				throw new Error(constants.folderAlreadyExists(path.parse(absoluteFolderPath).name));
			}

			await project.addFolderItem(relativeFolderPath);
			this.refreshProjectsTree();
		} catch (err) {
			this.apiWrapper.showErrorMessage(utils.getErrorMessage(err));
		}
	}

	public isReservedFolder(absoluteFolderPath: string, projectFolderPath: string): boolean {
		const sameName = reservedProjectFolders.find(f => f === path.parse(absoluteFolderPath).name) !== undefined;
		const sameLocation = path.parse(absoluteFolderPath).dir === projectFolderPath;
		return sameName && sameLocation;
	}

	public async addItemPromptFromNode(treeNode: BaseProjectTreeItem, itemTypeName?: string) {
		await this.addItemPrompt(this.getProjectFromContext(treeNode), this.getRelativePath(treeNode), itemTypeName);
	}

	public async addItemPrompt(project: Project, relativePath: string, itemTypeName?: string) {
		if (!itemTypeName) {
			const items: QuickPickItem[] = [];

			for (const itemType of templates.projectScriptTypes()) {
				items.push({ label: itemType.friendlyName });
			}

			itemTypeName = (await this.apiWrapper.showQuickPick(items, {
				canPickMany: false
			}))?.label;

			if (!itemTypeName) {
				return; // user cancelled
			}
		}

		const itemType = templates.projectScriptTypeMap()[itemTypeName.toLocaleLowerCase()];
		let itemObjectName = await this.promptForNewObjectName(itemType, project);

		itemObjectName = itemObjectName?.trim();

		if (!itemObjectName) {
			return; // user cancelled
		}

		const newFileText = this.macroExpansion(itemType.templateScript, { 'OBJECT_NAME': itemObjectName });
		const relativeFilePath = path.join(relativePath, itemObjectName + constants.sqlFileExtension);

		try {
			// check if file already exists
			const absoluteFilePath = path.join(project.projectFolderPath, relativeFilePath);
			const fileExists = await utils.exists(absoluteFilePath);

			if (fileExists) {
				throw new Error(constants.fileAlreadyExists(path.parse(absoluteFilePath).name));
			}

			const newEntry = await project.addScriptItem(relativeFilePath, newFileText);

			await this.apiWrapper.executeCommand(constants.vscodeOpenCommand, newEntry.fsUri);

			this.refreshProjectsTree();
		} catch (err) {
			this.apiWrapper.showErrorMessage(utils.getErrorMessage(err));
		}
	}

	public async exclude(context: FileNode | FolderNode): Promise<void> {
		const project = this.getProjectFromContext(context);

		const fileEntry = this.getProjectEntry(project, context);

		if (fileEntry) {
			await project.exclude(fileEntry);
		} else {
			this.apiWrapper.showErrorMessage(constants.unableToPerformAction(constants.excludeAction, context.uri.path));
		}

		this.refreshProjectsTree();
	}

	public async delete(context: BaseProjectTreeItem): Promise<void> {
		const project = this.getProjectFromContext(context);

		const confirmationPrompt = context instanceof FolderNode ? constants.deleteConfirmationContents(context.friendlyName) : constants.deleteConfirmation(context.friendlyName);
		const response = await this.apiWrapper.showWarningMessageOptions(confirmationPrompt, { modal: true }, constants.yesString);

		if (response !== constants.yesString) {
			return;
		}

		let success = false;

		if (context instanceof FileNode || FolderNode) {
			const fileEntry = this.getProjectEntry(project, context);

			if (fileEntry) {
				await project.deleteFileFolder(fileEntry);
				success = true;
			}
		}

		if (success) {
			this.refreshProjectsTree();
		} else {
			this.apiWrapper.showErrorMessage(constants.unableToPerformAction(constants.deleteAction, context.uri.path));
		}
	}

	private getProjectEntry(project: Project, context: BaseProjectTreeItem): ProjectEntry | undefined {
		return project.files.find(x => utils.getPlatformSafeFileEntryPath(x.relativePath) === utils.getPlatformSafeFileEntryPath(utils.trimUri(context.root.uri, context.uri)));
	}

	/**
	 * Opens the folder containing the project
	 * @param context a treeItem in a project's hierarchy, to be used to obtain a Project
	 */
	public async openContainingFolder(context: BaseProjectTreeItem): Promise<void> {
		const project = this.getProjectFromContext(context);
		await this.apiWrapper.executeCommand(constants.revealFileInOsCommand, Uri.file(project.projectFilePath));
	}

	/**
	 * Adds a database reference to the project
	 * @param context a treeItem in a project's hierarchy, to be used to obtain a Project
	 */
	public async addDatabaseReference(context: Project | BaseProjectTreeItem): Promise<void> {
		const project = this.getProjectFromContext(context);

		try {
			// choose if reference is to master or a dacpac
			const databaseReferenceType = await this.getDatabaseReferenceType();

			// if master is selected, we know which dacpac needs to be added
			if (databaseReferenceType === constants.systemDatabase) {
				const systemDatabase = await this.getSystemDatabaseName(project);
				await project.addSystemDatabaseReference(systemDatabase);
			} else {
				// get other information needed to add a reference to the dacpac
				const dacpacFileLocation = await this.getDacpacFileLocation();
				const databaseLocation = await this.getDatabaseLocation();

				if (databaseLocation === DatabaseReferenceLocation.differentDatabaseSameServer) {
					const databaseName = await this.getDatabaseName(dacpacFileLocation);
					await project.addDatabaseReference(dacpacFileLocation, databaseLocation, databaseName);
				} else {
					await project.addDatabaseReference(dacpacFileLocation, databaseLocation);
				}
			}

			this.refreshProjectsTree();
		} catch (err) {
			this.apiWrapper.showErrorMessage(utils.getErrorMessage(err));
		}
	}

	private async getDatabaseReferenceType(): Promise<string> {
		let databaseReferenceOptions: QuickPickItem[] = [
			{
				label: constants.systemDatabase
			},
			{
				label: constants.dacpac
			}
		];

		let input = await this.apiWrapper.showQuickPick(databaseReferenceOptions, {
			canPickMany: false,
			placeHolder: constants.addDatabaseReferenceInput
		});

		if (!input) {
			throw new Error(constants.databaseReferenceTypeRequired);
		}

		return input.label;
	}

	public async getSystemDatabaseName(project: Project): Promise<SystemDatabase> {
		let databaseReferenceOptions: QuickPickItem[] = [
			{
				label: constants.master
			}
		];

		// Azure dbs can only reference master
		if (project.getProjectTargetPlatform() !== TargetPlatform.SqlAzureV12) {
			databaseReferenceOptions.push(
				{
					label: constants.msdb
				});
		}

		let input = await this.apiWrapper.showQuickPick(databaseReferenceOptions, {
			canPickMany: false,
			placeHolder: constants.systemDatabaseReferenceInput
		});

		if (!input) {
			throw new Error(constants.systemDatabaseReferenceRequired);
		}

		return input.label === constants.master ? SystemDatabase.master : SystemDatabase.msdb;
	}

	private async getDacpacFileLocation(): Promise<Uri> {
		let fileUris = await this.apiWrapper.showOpenDialog(
			{
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
				defaultUri: this.apiWrapper.workspaceFolders() ? (this.apiWrapper.workspaceFolders() as WorkspaceFolder[])[0].uri : undefined,
				openLabel: constants.selectString,
				filters: {
					[constants.dacpacFiles]: ['dacpac'],
				}
			}
		);

		if (!fileUris || fileUris.length === 0) {
			throw new Error(constants.dacpacFileLocationRequired);
		}

		return fileUris[0];
	}

	private async getDatabaseLocation(): Promise<DatabaseReferenceLocation> {
		let databaseReferenceOptions: QuickPickItem[] = [
			{
				label: constants.databaseReferenceSameDatabase
			},
			{
				label: constants.databaseReferenceDifferentDabaseSameServer
			}
		];

		let input = await this.apiWrapper.showQuickPick(databaseReferenceOptions, {
			canPickMany: false,
			placeHolder: constants.databaseReferenceLocation
		});

		if (input === undefined) {
			throw new Error(constants.databaseLocationRequired);
		}

		const location = input?.label === constants.databaseReferenceSameDatabase ? DatabaseReferenceLocation.sameDatabase : DatabaseReferenceLocation.differentDatabaseSameServer;
		return location;
	}

	private async getDatabaseName(dacpac: Uri): Promise<string | undefined> {
		const dacpacName = path.parse(dacpac.toString()).name;
		let databaseName = await this.apiWrapper.showInputBox({
			prompt: constants.databaseReferenceDatabaseName,
			value: `${dacpacName}`
		});

		if (!databaseName) {
			throw new Error(constants.databaseNameRequired);
		}

		databaseName = databaseName?.trim();
		return databaseName;
	}

	//#region Helper methods

	public getPublishDialog(project: Project): PublishDatabaseDialog {
		return new PublishDatabaseDialog(this.apiWrapper, project);
	}

	public async updateProjectForRoundTrip(project: Project) {
		if (project.importedTargets.includes(constants.NetCoreTargets) && !project.containsSSDTOnlySystemDatabaseReferences()) {
			return;
		}

		if (!project.importedTargets.includes(constants.NetCoreTargets)) {
			const result = await this.apiWrapper.showWarningMessage(constants.updateProjectForRoundTrip, constants.yesString, constants.noString);
			if (result === constants.yesString) {
				await project.updateProjectForRoundTrip();
				await project.updateSystemDatabaseReferencesInProjFile();
			}
		} else if (project.containsSSDTOnlySystemDatabaseReferences()) {
			const result = await this.apiWrapper.showWarningMessage(constants.updateProjectDatabaseReferencesForRoundTrip, constants.yesString, constants.noString);
			if (result === constants.yesString) {
				await project.updateSystemDatabaseReferencesInProjFile();
			}
		}
	}

	private getProjectFromContext(context: Project | BaseProjectTreeItem) {
		if (context instanceof Project) {
			return context;
		}

		if (context.root instanceof ProjectRootTreeItem) {
			return (<ProjectRootTreeItem>context.root).project;
		}
		else {
			throw new Error(constants.unexpectedProjectContext(context.uri.path));
		}
	}

	public async getDaxFxService(): Promise<mssql.IDacFxService> {
		const ext: Extension<any> = extensions.getExtension(mssql.extension.name)!;

		await ext.activate();
		return (ext.exports as mssql.IExtension).dacFx;
	}

	private macroExpansion(template: string, macroDict: Record<string, string>): string {
		const macroIndicator = '@@';
		let output = template;

		for (const macro in macroDict) {
			// check if value contains the macroIndicator, which could break expansion for successive macros
			if (macroDict[macro].includes(macroIndicator)) {
				throw new Error(`Macro value ${macroDict[macro]} is invalid because it contains ${macroIndicator}`);
			}

			output = output.replace(new RegExp(macroIndicator + macro + macroIndicator, 'g'), macroDict[macro]);
		}

		return output;
	}

	private async promptForNewObjectName(itemType: templates.ProjectScriptType, _project: Project): Promise<string | undefined> {
		// TODO: ask project for suggested name that doesn't conflict
		const suggestedName = itemType.friendlyName.replace(new RegExp('\s', 'g'), '') + '1';

		const itemObjectName = await this.apiWrapper.showInputBox({
			prompt: constants.newObjectNamePrompt(itemType.friendlyName),
			value: suggestedName,
		});

		return itemObjectName;
	}

	private getRelativePath(treeNode: BaseProjectTreeItem): string {
		return treeNode instanceof FolderNode ? utils.trimUri(treeNode.root.uri, treeNode.uri) : '';
	}

	/**
	 * Imports a new SQL database project from the existing database,
	 * prompting the user for a name, file path location and extract target
	 */
	public async importNewDatabaseProject(context: IConnectionProfile | any): Promise<void> {
		let model = <ImportDataModel>{};

		// TODO: Refactor code
		try {
			let profile = this.getConnectionProfileFromContext(context);
			//TODO: Prompt for new connection addition and get database information if context information isn't provided.

			let connectionId;
			if (profile) {
				model.database = profile.databaseName;
				connectionId = profile.id;
			}
			else {
				const connection = await this.apiWrapper.openConnectionDialog();
				if (!connection) {
					return;
				}

				connectionId = connection.connectionId;

				// use database that was connected to
				if (connection.options['database']) {
					model.database = connection.options['database'];
				}
			}

			// choose database if connection was to a server or master
			if (!model.database || model.database === constants.master) {
				const databaseList = await this.apiWrapper.listDatabases(connectionId);
				let database = (await this.apiWrapper.showQuickPick(databaseList.map(dbName => { return { label: dbName }; }),
					{
						canPickMany: false,
						placeHolder: constants.extractDatabaseSelection
					}))?.label;

				if (!database) {
					throw new Error(constants.databaseSelectionRequired);
				}

				model.database = database;
				model.serverId = connectionId;
			}

			// Get project name
			let newProjName = await this.getProjectName(model.database);
			if (!newProjName) {
				throw new Error(constants.projectNameRequired);
			}
			model.projName = newProjName;

			// Get extractTarget
			let extractTarget: mssql.ExtractTarget = await this.getExtractTarget();
			model.extractTarget = extractTarget;

			// Get folder location for project creation
			let newProjUri = await this.getFolderLocation(model.extractTarget);
			if (!newProjUri) {
				throw new Error(constants.projectLocationRequired);
			}

			// Set project folder/file location
			let newProjFolderUri;
			if (extractTarget === mssql.ExtractTarget['file']) {
				// Get folder info, if extractTarget = File
				newProjFolderUri = Uri.file(path.dirname(newProjUri.fsPath));
			} else {
				newProjFolderUri = newProjUri;
			}

			// Check folder is empty
			let isEmpty: boolean = await this.isDirEmpty(newProjFolderUri.fsPath);
			if (!isEmpty) {
				throw new Error(constants.projectLocationNotEmpty);
			}
			// TODO: what if the selected folder is outside the workspace?
			model.filePath = newProjUri.fsPath;

			//Set model version
			model.version = '1.0.0.0';

			// Call ExtractAPI in DacFx Service
			await this.importApiCall(model);
			// TODO: Check for success

			// Create and open new project
			const newProjFilePath = await this.createNewProject(newProjName as string, newProjFolderUri as Uri, false);
			const project = await this.openProject(Uri.file(newProjFilePath));

			//Create a list of all the files and directories to be added to project
			let fileFolderList: string[] = await this.generateList(model.filePath);

			// Add generated file structure to the project
			await project.addToProject(fileFolderList);

			//Refresh project to show the added files
			this.refreshProjectsTree();
		}
		catch (err) {
			this.apiWrapper.showErrorMessage(utils.getErrorMessage(err));
		}
	}

	private getConnectionProfileFromContext(context: IConnectionProfile | any): IConnectionProfile | undefined {
		if (!context) {
			return undefined;
		}

		// depending on where import new project is launched from, the connection profile could be passed as just
		// the profile or it could be wrapped in another object
		return (<any>context).connectionProfile ? (<any>context).connectionProfile : context;
	}

	private async getProjectName(dbName: string): Promise<string | undefined> {
		let projName = await this.apiWrapper.showInputBox({
			prompt: constants.newDatabaseProjectName,
			value: `DatabaseProject${dbName}`
		});

		projName = projName?.trim();

		return projName;
	}

	private mapExtractTargetEnum(inputTarget: any): mssql.ExtractTarget {
		if (inputTarget) {
			switch (inputTarget) {
				case constants.file: return mssql.ExtractTarget['file'];
				case constants.flat: return mssql.ExtractTarget['flat'];
				case constants.objectType: return mssql.ExtractTarget['objectType'];
				case constants.schema: return mssql.ExtractTarget['schema'];
				case constants.schemaObjectType: return mssql.ExtractTarget['schemaObjectType'];
				default: throw new Error(constants.invalidInput(inputTarget));
			}
		} else {
			throw new Error(constants.extractTargetRequired);
		}
	}

	private async getExtractTarget(): Promise<mssql.ExtractTarget> {
		let extractTarget: mssql.ExtractTarget;

		let extractTargetOptions: QuickPickItem[] = [];

		let keys = [constants.file, constants.flat, constants.objectType, constants.schema, constants.schemaObjectType];

		// TODO: Create a wrapper class to handle the mapping
		keys.forEach((targetOption: string) => {
			extractTargetOptions.push({ label: targetOption });
		});

		let input = await this.apiWrapper.showQuickPick(extractTargetOptions, {
			canPickMany: false,
			placeHolder: constants.extractTargetInput
		});
		let extractTargetInput = input?.label;

		extractTarget = this.mapExtractTargetEnum(extractTargetInput);

		return extractTarget;
	}

	private async getFolderLocation(extractTarget: mssql.ExtractTarget): Promise<Uri | undefined> {
		let selectionResult;
		let projUri;

		if (extractTarget !== mssql.ExtractTarget.file) {
			selectionResult = await this.apiWrapper.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				openLabel: constants.selectString,
				defaultUri: this.apiWrapper.workspaceFolders() ? (this.apiWrapper.workspaceFolders() as WorkspaceFolder[])[0].uri : undefined
			});
			if (selectionResult) {
				projUri = (selectionResult as Uri[])[0];
			}
		} else {
			// Get filename
			selectionResult = await this.apiWrapper.showSaveDialog(
				{
					defaultUri: this.apiWrapper.workspaceFolders() ? (this.apiWrapper.workspaceFolders() as WorkspaceFolder[])[0].uri : undefined,
					saveLabel: constants.selectString,
					filters: {
						'SQL files': ['sql'],
						'All files': ['*']
					}
				}
			);
			if (selectionResult) {
				projUri = selectionResult as unknown as Uri;
			}
		}

		return projUri;
	}

	private async isDirEmpty(newProjFolderUri: string): Promise<boolean> {
		return (await fs.readdir(newProjFolderUri)).length === 0;
	}

	private async importApiCall(model: ImportDataModel): Promise<void> {
		let ext = this.apiWrapper.getExtension(mssql.extension.name)!;

		const service = (await ext.activate() as mssql.IExtension).dacFx;
		const ownerUri = await this.apiWrapper.getUriForConnection(model.serverId);

		await service.importDatabaseProject(model.database, model.filePath, model.projName, model.version, ownerUri, model.extractTarget, TaskExecutionMode.execute);
	}

	/**
	 * Generate a flat list of all files and folder under a folder.
	 */
	public async generateList(absolutePath: string): Promise<string[]> {
		let fileFolderList: string[] = [];

		if (!await utils.exists(absolutePath)) {
			if (await utils.exists(absolutePath + constants.sqlFileExtension)) {
				absolutePath += constants.sqlFileExtension;
			} else {
				await this.apiWrapper.showErrorMessage(constants.cannotResolvePath(absolutePath));
				return fileFolderList;
			}
		}

		const files = [absolutePath];
		do {
			const filepath = files.pop();

			if (filepath) {
				const stat = await fs.stat(filepath);

				if (stat.isDirectory()) {
					fileFolderList.push(filepath);
					(await fs
						.readdir(filepath))
						.forEach((f: string) => files.push(path.join(filepath, f)));
				}
				else if (stat.isFile()) {
					fileFolderList.push(filepath);
				}
			}

		} while (files.length !== 0);

		return fileFolderList;
	}

	//#endregion
}
