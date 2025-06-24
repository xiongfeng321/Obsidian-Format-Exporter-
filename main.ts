import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, Component, MarkdownRenderer } from 'obsidian';

// 为单个CSS配置定义接口
interface CssProfile {
    name: string;
    path: string;
}

// 为插件设置定义一个接口
interface MyPluginSettings {
    activeProfileName: string;
    profiles: CssProfile[];
    imageHandling: 'base64' | 'keep-path';
}

// 定义默认设置
const DEFAULT_SETTINGS: MyPluginSettings = {
    activeProfileName: 'Default',
    profiles: [
        { name: '微信公众号样式', path: 'styles/wechat.css' }
    ],
    imageHandling: 'base64'
}

export default class MyPlugin extends Plugin {
    settings: MyPluginSettings;

    private readonly STYLE_PROPERTIES_WHITELIST: string[] = [
        'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style',
        'text-align', 'text-decoration', 'line-height',
        'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
        'border-width', 'border-style', 'border-color',
        'list-style-type', 'display', 'vertical-align', 'white-space',
        'box-sizing'
    ];

    async onload() {
        console.log('公众号导出伴侣插件加载成功！');
        await this.loadSettings();

        this.addCommand({
            id: 'copy-as-wechat-format',
            name: '复制为公众号格式 (Copy as WeChat Format)',
            callback: () => this.processAndCopy()
        });

        this.addSettingTab(new ExportSettingTab(this.app, this));
    }

    async processAndCopy() {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!activeView || !activeView.file) {
            new Notice('错误：请先打开一个笔记文件！');
            return;
        }

        new Notice('正在处理，请稍候...', 5000);

        try {
            const markdown = await this.app.vault.cachedRead(activeView.file);
            let processedMarkdown = markdown;
            if (this.settings.imageHandling === 'base64') {
                processedMarkdown = await this.inlineImagesInMarkdown(markdown, activeView);
            }
            
            const allCss = await this.aggregateStyles();
            const inlinedHtml = await this.inlineStylesWithIframe(processedMarkdown, allCss, activeView.file.path);
            this.copyRichText(inlinedHtml);
            new Notice('✅ 成功复制到剪贴板！');

        } catch (error) {
            console.error('导出为公众号格式失败:', error);
            new Notice(`❌ 导出失败: ${error.message}`);
        }
    }
    
    async inlineStylesWithIframe(markdown: string, css: string, sourcePath: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const iframe = document.createElement('iframe');
            iframe.style.position = 'absolute';
            iframe.style.left = '-9999px';
            iframe.style.width = '800px';
            document.body.appendChild(iframe);

            const iframeDocument = iframe.contentWindow?.document;
            if (!iframeDocument) {
                document.body.removeChild(iframe);
                reject(new Error("无法访问iframe的document"));
                return;
            }

            iframe.onload = () => {
                try {
                    const body = iframeDocument.body;
                    this.cleanupHTML(body);
                    this.applyComputedStyles(body, iframe.contentWindow!);
                    const finalHtml = body.innerHTML;
                    document.body.removeChild(iframe);
                    resolve(finalHtml);
                } catch (e) {
                    document.body.removeChild(iframe);
                    reject(e);
                }
            };

            const bodyClasses = document.body.className;
            const component = new Component();
            const contentContainer = document.createElement('div');
            
            MarkdownRenderer.render(this.app, markdown, contentContainer, sourcePath, component).then(() => {
                component.unload();
                const html = `
                    <html><head><style>${css}</style></head>
                    <body class="${bodyClasses}"><div class="markdown-preview-view">${contentContainer.innerHTML}</div></body>
                    </html>`;
                iframeDocument.open();
                iframeDocument.write(html);
                iframeDocument.close();
            });
        });
    }

    cleanupHTML(element: HTMLElement) {
        element.querySelectorAll('.copy-code-button').forEach(button => button.remove());
    }

    applyComputedStyles(element: HTMLElement, win: Window) {
        const computedStyle = win.getComputedStyle(element);
        let styleString = '';
        
        for (const prop of this.STYLE_PROPERTIES_WHITELIST) {
            const value = computedStyle.getPropertyValue(prop);
            if (value && value !== 'none' && value !== 'normal' && value !== 'auto') {
                styleString += `${prop}: ${value}; `;
            }
        }
        
        if (styleString) element.setAttribute('style', styleString);
        for (const child of Array.from(element.children)) this.applyComputedStyles(child as HTMLElement, win);
    }

    copyRichText(html: string) {
        const tempDiv = document.createElement('div');
        tempDiv.contentEditable = 'true';
        tempDiv.style.position = 'absolute';
        tempDiv.style.left = '-9999px';
        tempDiv.innerHTML = html;
        document.body.appendChild(tempDiv);
        try {
            const selection = window.getSelection();
            const range = document.createRange();
            if (!selection) throw new Error('window.getSelection() is not available.');
            range.selectNodeContents(tempDiv);
            selection.removeAllRanges(); 
            selection.addRange(range);
            if (!document.execCommand('copy')) throw new Error('document.execCommand("copy") failed.');
        } catch (err) {
            console.error('复制到剪贴板失败:', err);
            throw err;
        } finally {
            if (document.body.contains(tempDiv)) document.body.removeChild(tempDiv);
        }
    }

    async inlineImagesInMarkdown(markdown: string, activeView: MarkdownView): Promise<string> {
        const imageRegex = /!\[(.*?)\]\((.*?)\)|!\[\[(.*?)\]\]/g;
        const segments: (string | Promise<string>)[] = [];
        let lastIndex = 0;
        let match;
        while ((match = imageRegex.exec(markdown)) !== null) {
            segments.push(markdown.substring(lastIndex, match.index));
            const [fullMatch, alt, src, wikilink] = match;
            const imageSrc = src || wikilink;
            const imageAlt = alt || wikilink;
            segments.push((async () => {
                if (imageSrc && !imageSrc.startsWith('http')) {
                    const decodedSrc = decodeURIComponent(imageSrc);
                    const file = this.app.metadataCache.getFirstLinkpathDest(decodedSrc, activeView.file?.path || "");
                    if (file instanceof TFile) {
                        const binaryData = await this.app.vault.readBinary(file);
                        const base64String = this.arrayBufferToBase64(binaryData);
                        const mimeType = this.getMimeType(file.extension);
                        return `![${imageAlt}](${`data:${mimeType};base64,${base64String}`})`;
                    }
                }
                return fullMatch;
            })());
            lastIndex = imageRegex.lastIndex;
        }
        segments.push(markdown.substring(lastIndex));
        const resolvedSegments = await Promise.all(segments);
        return resolvedSegments.join('');
    }

    async aggregateStyles(): Promise<string> {
        const activeProfileName = this.settings.activeProfileName;
        if (activeProfileName && activeProfileName !== 'Default') {
            const profile = this.settings.profiles.find(p => p.name === activeProfileName);
            if (profile && profile.path) {
                try {
                    if (await this.app.vault.adapter.exists(profile.path)) {
                        console.log(`正在使用自定义CSS: ${profile.path}`);
                        return await this.app.vault.adapter.read(profile.path);
                    } else {
                        throw new Error(`指定的CSS文件不存在: ${profile.path}`);
                    }
                } catch (e) {
                    console.error("读取自定义CSS失败:", e);
                    throw e;
                }
            }
        }
        console.log("正在聚合当前主题和片段的CSS...");
        const collectedCss = [];
        for (const sheet of Array.from(document.styleSheets)) {
            try {
                if (sheet.cssRules) {
                    collectedCss.push(Array.from(sheet.cssRules).map(rule => rule.cssText).join('\n'));
                }
            } catch (e) {
                console.warn("无法读取样式表中的CSS规则:", sheet.href, e);
            }
        }
        return collectedCss.join('\n\n');
    }
    
    arrayBufferToBase64(buffer: ArrayBuffer): string {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
        return window.btoa(binary);
    }
    
    getMimeType(extension: string): string {
        switch (extension.toLowerCase()) {
            case 'png': return 'image/png';
            case 'jpg': case 'jpeg': return 'image/jpeg';
            case 'gif': return 'image/gif';
            case 'svg': return 'image/svg+xml';
            case 'webp': return 'image/webp';
            default: return 'application/octet-stream';
        }
    }

    onunload() { console.log('公众号导出伴侣插件卸载成功。'); }
    async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
	async saveSettings() { await this.saveData(this.settings); }
}

class ExportSettingTab extends PluginSettingTab {
	plugin: MyPlugin;
	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}
	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		containerEl.createEl('h2', {text: '公众号导出伴侣 - 设置'});

        // **核心修改：将图片导出方式的下拉菜单改为按钮组**
        new Setting(containerEl)
            .setName('图片导出方式')
            .setDesc('选择复制时如何处理笔记中的本地图片。')
            .addButton(button => {
                button
                    .setButtonText('内联为Base64')
                    .setTooltip('将图片嵌入HTML，适合直接发布')
                    .onClick(async () => {
                        this.plugin.settings.imageHandling = 'base64';
                        await this.plugin.saveSettings();
                        this.display(); // 重新渲染以更新按钮状态
                    });
                // 如果当前是激活状态，添加高亮class
                if (this.plugin.settings.imageHandling === 'base64') {
                    button.setCta();
                }
            })
            .addButton(button => {
                button
                    .setButtonText('保留本地路径')
                    .setTooltip('保持图片为本地引用，适合二次编辑')
                    .onClick(async () => {
                        this.plugin.settings.imageHandling = 'keep-path';
                        await this.plugin.saveSettings();
                        this.display(); // 重新渲染以更新按钮状态
                    });
                if (this.plugin.settings.imageHandling === 'keep-path') {
                    button.setCta();
                }
            });
        
        const profiles = this.plugin.settings.profiles;
        const profileOptions: Record<string, string> = { 'Default': '默认 (跟随Obsidian主题)' };
        profiles.forEach(p => {
            if (p.name) profileOptions[p.name] = p.name;
        });

        new Setting(containerEl)
            .setName('选择导出样式配置')
            .setDesc('选择一个配置用于导出。选择“默认”则使用当前Obsidian的主题和CSS片段。')
            .addDropdown(dropdown => dropdown
                .addOptions(profileOptions)
                .setValue(this.plugin.settings.activeProfileName)
                .onChange(async (value) => {
                    this.plugin.settings.activeProfileName = value;
                    await this.plugin.saveSettings();
                }));

        // **核心修改：使用 setHeading() 来创建统一风格的标题**
        new Setting(containerEl)
            .setHeading()
            .setName('管理样式配置');

        const descEl = containerEl.createDiv({ cls: 'setting-item-description' });
        descEl.createEl('p', { text: '在这里添加和管理用于导出的CSS样式配置。' });
        const p = descEl.createEl('p');
        p.appendText('“配置名称”会显示在上面的下拉菜单中。“CSS文件路径”是相对于您Obsidian库根目录的路径。');
        p.appendText(' 例如：在您的库根目录创建一个名为 ');
        p.createEl('code', { text: 'styles' });
        p.appendText(' 的文件夹，并将您的CSS文件（如 ');
        p.createEl('code', { text: 'wechat.css' });
        p.appendText('）放进去，然后在此处填入 ');
        p.createEl('code', { text: 'styles/wechat.css' });
        p.appendText('。');


        profiles.forEach((profile, index) => {
            new Setting(containerEl)
                .addText(text => text
                    .setPlaceholder('配置名称, 例如: 微信')
                    .setValue(profile.name)
                    .onChange(async (value) => {
                        profile.name = value;
                        await this.plugin.saveSettings();
                        this.display();
                    }))
                .addText(text => text
                    .setPlaceholder('CSS文件路径, 例如: styles/wechat.css')
                    .setValue(profile.path)
                    .onChange(async (value) => {
                        profile.path = value;
                        await this.plugin.saveSettings();
                    }))
                .addButton(button => button
                    .setButtonText('删除')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.profiles.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.display();
                    }));
        });
        
        new Setting(containerEl)
            .addButton(button => button
                .setButtonText('添加新配置')
                .onClick(async () => {
                    this.plugin.settings.profiles.push({ name: '', path: '' });
                    await this.plugin.saveSettings();
                    this.display();
                }));
        
        containerEl.createEl('hr');

        const donationDiv = containerEl.createDiv('donation-section');
        donationDiv.createEl('h3', { text: '💖 支持作者' });
        donationDiv.createEl('p', { text: '如果这个插件为您节省了宝贵的时间，解决了您的排版烦恼，欢迎给我买杯咖啡！您的认可和支持，是我持续更新和开发更多好用插件的最大动力。' });
        
        new Setting(donationDiv)
            .addButton(button => button
                .setButtonText('前往“爱发电”支持')
                .setCta()
                .onClick(() => { window.open('https://afdian.com/a/xiongfeng'); }))
            
	}
}
