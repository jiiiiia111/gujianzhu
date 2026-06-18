/**
 * 基于文本文件的问答存储系统
 * 注意：需要通过 HTTP 服务器访问，不能直接用 file:// 协议
 */

class FileQAStore {
    constructor() {
        this.questions = [];
        this.answers = [];
        this.cacheKey = 'file-qa-cache';
    }

    /**
     * 初始化：从文本文件加载问答
     */
    async loadFromFiles() {
        try {
            // 先尝试从 localStorage 加载缓存
            const cachedData = localStorage.getItem(this.cacheKey);
            if (cachedData) {
                const data = JSON.parse(cachedData);
                this.questions = data.questions;
                this.answers = data.answers;
                console.log('从缓存加载问答数据，条数:', this.questions.length);
                return true;
            }

            // 从文件加载
            const [questionsResponse, answersResponse] = await Promise.all([
                fetch('questions.txt'),
                fetch('answers.txt')
            ]);

            if (!questionsResponse.ok || !answersResponse.ok) {
                console.warn('问答文件加载失败，使用空数据');
                return false;
            }

            const questionsText = await questionsResponse.text();
            const answersText = await answersResponse.text();

            // 解析文本（每行一个问题/答案）
            this.questions = questionsText.trim().split('\n').filter(q => q.trim());
            this.answers = answersText.trim().split('\n').filter(a => a.trim());

            // 验证数量是否匹配
            if (this.questions.length !== this.answers.length) {
                console.warn('问题和答案数量不匹配！问题:', this.questions.length, '答案:', this.answers.length);
            }

            // 缓存到 localStorage
            this.saveToCache();

            console.log('从文件加载问答数据成功，条数:', this.questions.length);
            return true;
        } catch (error) {
            console.error('加载问答文件失败:', error);
            return false;
        }
    }

    /**
     * 搜索答案
     */
    searchAnswer(question) {
        if (!question) return null;

        const trimmedQuestion = question.trim().toLowerCase();

        // 精确匹配
        const exactIndex = this.questions.findIndex(q => q.trim().toLowerCase() === trimmedQuestion);
        if (exactIndex >= 0) {
            return this.answers[exactIndex];
        }

        // 包含匹配
        for (let i = 0; i < this.questions.length; i++) {
            if (trimmedQuestion.includes(this.questions[i].trim().toLowerCase()) ||
                this.questions[i].trim().toLowerCase().includes(trimmedQuestion)) {
                return this.answers[i];
            }
        }

        return null;
    }

    /**
     * 添加新的问答对
     */
    addQuestionAnswer(question, answer) {
        if (!question || !answer) {
            console.error('问题和答案不能为空');
            return false;
        }

        const trimmedQuestion = question.trim();

        // 检查是否已存在
        const existingIndex = this.questions.findIndex(q => q.trim().toLowerCase() === trimmedQuestion.toLowerCase());

        if (existingIndex >= 0) {
            // 更新现有答案
            this.answers[existingIndex] = answer.trim();
            console.log('更新现有问答:', trimmedQuestion);
        } else {
            // 添加新问答
            this.questions.push(trimmedQuestion);
            this.answers.push(answer.trim());
            console.log('添加新问答:', trimmedQuestion);
        }

        // 保存到缓存
        this.saveToCache();

        // 尝试保存到文件（需要后端支持）
        this.saveToFiles();

        return true;
    }

    /**
     * 保存到 localStorage 缓存
     */
    saveToCache() {
        const data = {
            questions: this.questions,
            answers: this.answers
        };
        localStorage.setItem(this.cacheKey, JSON.stringify(data));
    }

    /**
     * 保存到文本文件（需要后端支持）
     * 纯前端无法直接写入文件，这里提供导出功能
     */
    saveToFiles() {
        // 导出为 JSON 供后端使用
        const exportData = {
            questions: this.questions.join('\n'),
            answers: this.answers.join('\n')
        };

        console.log('问答数据已更新（需要后端支持才能保存到文件）');
        console.log('导出数据:', exportData);

        return exportData;
    }

    /**
     * 导出问答数据为文本文件
     */
    exportAsFiles() {
        // 创建问题文件
        const questionsBlob = new Blob([this.questions.join('\n')], { type: 'text/plain;charset=utf-8' });
        const questionsUrl = URL.createObjectURL(questionsBlob);
        const questionsLink = document.createElement('a');
        questionsLink.href = questionsUrl;
        questionsLink.download = 'questions.txt';
        questionsLink.click();

        // 创建答案文件
        const answersBlob = new Blob([this.answers.join('\n')], { type: 'text/plain;charset=utf-8' });
        const answersUrl = URL.createObjectURL(answersBlob);
        const answersLink = document.createElement('a');
        answersLink.href = answersUrl;
        answersLink.download = 'answers.txt';
        answersLink.click();

        URL.revokeObjectURL(questionsUrl);
        URL.revokeObjectURL(answersUrl);
    }

    /**
     * 获取统计信息
     */
    getStatistics() {
        return {
            totalQuestions: this.questions.length
        };
    }

    /**
     * 清空数据
     */
    clearAll() {
        this.questions = [];
        this.answers = [];
        localStorage.removeItem(this.cacheKey);
    }
}

// 导出到全局
if (typeof window !== 'undefined') {
    window.FileQAStore = FileQAStore;
}
