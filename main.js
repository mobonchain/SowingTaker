require('colors');
const axios = require('axios');
const ethers = require('ethers');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const dotenv = require('dotenv');
const readline = require('readline');

dotenv.config();

const api = 'https://sowing-api.taker.xyz';
const contract = '0xF929AB815E8BfB84Cdab8d1bb53F22eB1e455378';
const abi = [
    {
        "constant": false,
        "inputs": [],
        "name": "active",
        "outputs": [],
        "payable": false,
        "stateMutability": "nonpayable",
        "type": "function"
    }
];

const SITE_KEY = '0x4AAAAAABNqF8H4KF9TDs2O';
const PAGE_URL = 'https://sowing.taker.xyz/';

const CAPTCHA_SERVICES = [
    { name: '2Captcha', key: process.env.TWOCAPTCHA_API, apiUrl: 'http://2captcha.com', method: 'turnstile' },
    { name: 'CapSolver', key: process.env.CAPSOLVER, apiUrl: 'https://api.capsolver.com', method: 'cf' },
    { name: 'Anti-Captcha', key: process.env.ANTICAPTCHA, apiUrl: 'https://api.anti-captcha.com', method: 'AntiTurnstileTaskProxyLess' },
];

const availableCaptchaServices = CAPTCHA_SERVICES.filter(service => service.key && service.key !== 'null');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const headers = {
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    'sec-ch-ua': '"Microsoft Edge";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'Referer': 'https://sowing.taker.xyz/',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const proxies = fs.existsSync('proxy.txt')
    ? fs.readFileSync('proxy.txt', 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
    : [];
if (proxies.length === 0) {
    console.warn('Không tìm thấy proxy trong proxy.txt. Chạy không dùng proxy.'.yellow);
}

const wallets = fs.existsSync('wallet.txt')
    ? fs.readFileSync('wallet.txt', 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map((key, i) => {
            try {
                const wallet = new ethers.Wallet(key);
                return {
                    privateKey: key,
                    address: wallet.address,
                    proxy: proxies[i] || null,
                };
            } catch (error) {
                console.error(`Private key ${i + 1} không hợp lệ: ${error.message}`.red);
                return null;
            }
        })
        .filter(wallet => wallet)
    : [];
if (wallets.length === 0) {
    throw new Error('Không tìm thấy private key hợp lệ trong wallet.txt'.red);
}

if (proxies.length < wallets.length) {
    console.warn(`Cảnh báo: Chỉ có ${proxies.length} proxy cho ${wallets.length} ví. Một số ví sẽ không dùng proxy.`.yellow);
}

const tokens = {};

function log(message, type = 'info') {
    let colored;
    switch (type) {
        case 'error':
            colored = `${message}`.red;
            break;
        case 'success':
            colored = `${message}`.green;
            break;
        case 'warning':
            colored = `${message}`.yellow;
            break;
        default:
            colored = `${message}`.cyan.bold;
    }
    console.log(colored);
}

function normalize_proxy(proxy) {
    if (!proxy) return null;
    if (!proxy.startsWith('http://') && !proxy.startsWith('https://')) {
        proxy = `http://${proxy}`;
    }
    return proxy;
}

function get_proxy_host(proxy) {
    if (!proxy) return 'Không có';
    const url = new URL(normalize_proxy(proxy));
    return `${url.hostname}:${url.port}`.yellow;
}

async function api_request(url, method = 'GET', data = null, token = null, proxy = null, customHeaders = {}) {
    const config = { 
        method, 
        url, 
        headers: { ...headers, ...customHeaders } 
    };
    if (data) config.data = data;
    if (token) config.headers['authorization'] = `Bearer ${token}`;
    if (proxy) config.httpsAgent = new HttpsProxyAgent(normalize_proxy(proxy));
    try {
        const response = await axios(config);
        return response.data;
    } catch (error) {
        throw new Error(error.response?.data?.message || error.message);
    }
}

async function selectCaptchaService() {
    if (availableCaptchaServices.length === 0) {
        throw new Error('Không có dịch vụ CAPTCHA nào được cấu hình trong .env');
    }
    if (availableCaptchaServices.length === 1) {
        log(`Sử dụng dịch vụ CAPTCHA: ${availableCaptchaServices[0].name}`, 'info');
        return availableCaptchaServices[0];
    }

    log('Có nhiều dịch vụ CAPTCHA được cấu hình. Vui lòng chọn:', 'info');
    availableCaptchaServices.forEach((service, index) => {
        log(`${index + 1}. ${service.name}`, 'info');
    });

    return new Promise((resolve, reject) => {
        rl.question('Nhập số tương ứng với dịch vụ CAPTCHA bạn muốn sử dụng: ', (answer) => {
            const index = parseInt(answer) - 1;
            if (index >= 0 && index < availableCaptchaServices.length) {
                log(`Đã chọn dịch vụ: ${availableCaptchaServices[index].name}`, 'success');
                resolve(availableCaptchaServices[index]);
            } else {
                reject(new Error('Lựa chọn không hợp lệ'));
            }
        });
    });
}

async function get_captcha_token(wallet, captchaService) {
    try {
        log(`Đang giải CAPTCHA với ${captchaService.name}...`, 'info');

        if (!captchaService.key) {
            throw new Error(`API key ${captchaService.name} không được cấu hình`);
        }

        let taskId, token;

        if (captchaService.name === '2Captcha') {
            const taskData = {
                key: captchaService.key,
                method: captchaService.method,
                sitekey: SITE_KEY,
                pageurl: PAGE_URL,
                json: 1
            };
            const createResponse = await axios.post(`${captchaService.apiUrl}/in.php`, taskData);
            const createResult = createResponse.data;

            if (createResult.status !== 1) {
                throw new Error(`Tạo nhiệm vụ CAPTCHA thất bại: ${createResult.request}`);
            }

            taskId = createResult.request;
            log(`Nhiệm vụ CAPTCHA được tạo: TaskID=${taskId}`, 'success');

            let attempts = 0;
            const maxAttempts = 30;
            const pollInterval = 6000;

            while (attempts < maxAttempts) {
                attempts++;
                log(`Đang kiểm tra kết quả CAPTCHA (lần ${attempts}/${maxAttempts})...`, 'info');
                const resultResponse = await axios.get(`${captchaService.apiUrl}/res.php?key=${captchaService.key}&action=get&id=${taskId}&json=1`);
                const result = resultResponse.data;

                if (result.status === 1) {
                    token = result.request;
                    log(`Lấy CaptchaToken thành công: ${token}`, 'success');
                    return token;
                }
                if (result.request === 'CAPCHA_NOT_READY') {
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                    continue;
                }
                throw new Error(`Lấy kết quả CAPTCHA thất bại: ${result.request}`);
            }
            throw new Error('Hết thời gian chờ kết quả CAPTCHA');
        }

        if (captchaService.name === 'CapSolver') {
            const taskData = {
                clientKey: captchaService.key,
                task: {
                    type: 'AntiTurnstileTaskProxyLess',
                    websiteURL: PAGE_URL,
                    websiteKey: SITE_KEY
                }
            };
            const createResponse = await axios.post(`${captchaService.apiUrl}/createTask`, taskData);
            const createResult = createResponse.data;

            if (createResult.errorId !== 0) {
                throw new Error(`Tạo nhiệm vụ CAPTCHA thất bại: ${createResult.errorDescription}`);
            }

            taskId = createResult.taskId;
            log(`Nhiệm vụ CAPTCHA được tạo: TaskID=${taskId}`, 'success');

            let attempts = 0;
            const maxAttempts = 30;
            const pollInterval = 5000;

            while (attempts < maxAttempts) {
                attempts++;
                log(`Đang kiểm tra kết quả CAPTCHA (lần ${attempts}/${maxAttempts})...`, 'info');
                const resultResponse = await axios.post(`${captchaService.apiUrl}/getTaskResult`, {
                    clientKey: captchaService.key,
                    taskId
                });
                const result = resultResponse.data;

                if (result.status === 'ready') {
                    token = result.solution.token;
                    log(`Lấy CaptchaToken thành công: ${token}`, 'success');
                    return token;
                }
                if (result.status === 'processing') {
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                    continue;
                }
                throw new Error(`Lấy kết quả CAPTCHA thất bại: ${result.errorDescription || 'Unknown error'}`);
            }
            throw new Error('Hết thời gian chờ kết quả CAPTCHA');
        }

        if (captchaService.name === 'Anti-Captcha') {
            const taskData = {
                clientKey: captchaService.key,
                task: {
                    type: captchaService.method,
                    websiteURL: PAGE_URL,
                    websiteKey: SITE_KEY
                }
            };
            const createResponse = await axios.post(`${captchaService.apiUrl}/createTask`, taskData);
            const createResult = createResponse.data;

            if (createResult.errorId !== 0) {
                throw new Error(`Tạo nhiệm vụ CAPTCHA thất bại: ${createResult.errorDescription}`);
            }

            taskId = createResult.taskId;
            log(`Nhiệm vụ CAPTCHA được tạo: TaskID=${taskId}`, 'success');

            let attempts = 0;
            const maxAttempts = 30;
            const pollInterval = 5000;

            while (attempts < maxAttempts) {
                attempts++;
                log(`Đang kiểm tra kết quả CAPTCHA (lần ${attempts}/${maxAttempts})...`, 'info');
                const resultResponse = await axios.post(`${captchaService.apiUrl}/getTaskResult`, {
                    clientKey: captchaService.key,
                    taskId
                });
                const result = resultResponse.data;

                if (result.status === 'ready') {
                    token = result.solution.token;
                    log(`Lấy CaptchaToken thành công: ${token}`, 'success');
                    return token;
                }
                if (result.status === 'processing') {
                    await new Promise(resolve => setTimeout(resolve, pollInterval));
                    continue;
                }
                throw new Error(`Lấy kết quả CAPTCHA thất bại: ${result.errorDescription || 'Unknown error'}`);
            }
            throw new Error('Hết thời gian chờ kết quả CAPTCHA');
        }

        throw new Error(`Dịch vụ CAPTCHA ${captchaService.name} không được hỗ trợ`);
    } catch (error) {
        log(`Lỗi khi giải CAPTCHA: ${error.message}`, 'error');
        throw new Error(`Giải CAPTCHA thất bại: ${error.message}`);
    }
}

async function get_nonce(wallet) {
    const response = await api_request(
        `${api}/wallet/generateNonce`,
        'POST',
        { walletAddress: ethers.getAddress(wallet.address) },
        null,
        wallet.proxy
    );
    if (response.code === 200) {
        if (response.result?.nonce) return response.result.nonce;
        const nonceMatch = response.result?.match?.(/Nonce: (.*)$/m);
        if (nonceMatch && nonceMatch[1]) return nonceMatch[1];
    }
    throw new Error('Không tạo được nonce: ' + (response.message || 'Lỗi không xác định'));
}

async function login(wallet, nonce) {
    const address = ethers.getAddress(wallet.address);
    const message = `Taker quest needs to verify your identity to prevent unauthorized access. Please confirm your sign-in details below:\n\naddress: ${address}\n\nNonce: ${nonce}`;
    const ethers_wallet = new ethers.Wallet(wallet.privateKey);
    
    let signature;
    try {
        signature = await ethers_wallet.signMessage(message);
    } catch (error) {
        log(`Tạo chữ ký thất bại: ${error.message}`, 'error');
        throw error;
    }

    const response = await api_request(
        `${api}/wallet/login`,
        'POST',
        { address, signature, message },
        null,
        wallet.proxy
    );

    if (response.code === 200) {
        return response.result.token;
    }

    log('Chữ ký chuẩn thất bại. Thử EIP-712...', 'warning');
    const domain = { name: 'Taker', version: '1', chainId: 1125 };
    const types = { Login: [{ name: 'address', type: 'address' }, { name: 'nonce', type: 'string' }] };
    const value = { address, nonce };

    try {
        signature = await ethers_wallet.signTypedData(domain, types, value);
    } catch (error) {
        log(`Tạo chữ ký EIP-712 thất bại: ${error.message}`, 'error');
        throw error;
    }

    const eip712_response = await api_request(
        `${api}/wallet/login`,
        'POST',
        { address, signature, message: JSON.stringify({ domain, types, value }) },
        null,
        wallet.proxy
    );

    if (eip712_response.code === 200) {
        return eip712_response.result.token;
    }
    throw new Error('Đăng nhập thất bại: ' + (response.message || eip712_response.message || 'Lỗi chữ ký'));
}

async function get_user_info(wallet, token) {
    const response = await api_request(`${api}/user/info`, 'GET', null, token, wallet.proxy);
    if (response.code === 200) return response.result;
    throw new Error('Không lấy được thông tin user: ' + response.message);
}

async function sign_in(wallet, token) {
    const response = await api_request(`${api}/task/signIn?status=true`, 'GET', null, token, wallet.proxy);
    if (response.code === 200) {
        log('Đăng nhập thành công! Bắt đầu farming.', 'success');
        return true;
    }
    log('Đăng nhập thất bại: ' + response.message, 'error');
    return false;
}

async function claim_reward(wallet, token, captchaService) {
    try {
        log('Bắt đầu nhận thưởng...', 'info');
        log('Đang giải CAPTCHA trước khi gọi hợp đồng...', 'info');
        const captchaToken = await get_captcha_token(wallet, captchaService);

        log('Đang kết nối blockchain...', 'info');
        const provider = new ethers.JsonRpcProvider('https://rpc-mainnet.taker.xyz', {
            chainId: 1125,
            name: 'Taker',
            nativeCurrency: { name: 'Taker', symbol: 'TAKER', decimals: 18 }
        });
        const ethers_wallet = new ethers.Wallet(wallet.privateKey, provider);
        const contract_instance = new ethers.Contract(contract, abi, ethers_wallet);

        log('Đang gửi giao dịch blockchain...', 'info');
        const tx = await contract_instance.active({
            gasLimit: 182832,
            maxPriorityFeePerGas: ethers.parseUnits('0.11', 'gwei'),
            maxFeePerGas: ethers.parseUnits('0.11135', 'gwei'),
            type: 2
        });

        log(`Gửi giao dịch: ${tx.hash}`, 'info');
        const receipt = await tx.wait();
        log(`Giao dịch xác nhận: ${receipt.hash}`, 'success');

        log('Đang gọi API signIn với CaptchaToken...', 'info');
        const sign_in_response = await api_request(
            `${api}/task/signIn?status=false`,
            'GET',
            null,
            token,
            wallet.proxy,
            { 'cf-turnstile-token': captchaToken }
        );

        if (sign_in_response.code === 200) {
            log('Start Farming thành công', 'success');
        } else {
            log(`Start Farming thất bại: ${sign_in_response.message}`, 'warning');
        }

        log('Nhận thưởng thành công!', 'success');
        return true;
    } catch (error) {
        log(`Lỗi khi nhận thưởng: ${error.message}`, 'error');
        return false;
    }
}

async function farm_cycle(wallet, token, captchaService) {
    try {
        const claim_success = await claim_reward(wallet, token, captchaService);
        if (!claim_success) {
            return false;
        }
        return true;
    } catch (error) {
        log(`Lỗi chu kỳ farming: ${error.message}`, 'error');
        return false;
    }
}

function format_time(timestamp) {
    const time_left = timestamp - Date.now();
    if (time_left <= 0) return '00:00:00';
    const hours = Math.floor(time_left / (1000 * 60 * 60));
    const minutes = Math.floor((time_left % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((time_left % (1000 * 60)) / 1000);
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function start_countdown(wallet, token, next_timestamp, captchaService) {
    if (wallet.countdown_interval) clearInterval(wallet.countdown_interval);

    const update = async () => {
        const time_left = next_timestamp - Date.now();
        if (time_left <= 0) {
            log('Chu kỳ farming hoàn tất!', 'success');
            clearInterval(wallet.countdown_interval);
            wallet.countdown_interval = null;
            await farm_cycle(wallet, token, captchaService);
            return;
        }
        log(`Thời gian còn lại: ${format_time(next_timestamp)}`, 'info');
    };

    update();
    wallet.countdown_interval = setInterval(update, 60000);
}

async function process_wallets(captchaService) {
    log(`Khởi động Taker Farming Bot cho ${wallets.length} ví`, 'success');
    
    for (let i = 0; i < wallets.length; i++) {
        const wallet = wallets[i];
        log(`Xử lý ví ${i + 1}/${wallets.length}`, 'info');
        log(`Proxy: ${get_proxy_host(wallet.proxy)}`, 'info');
        try {
            const nonce = await get_nonce(wallet);
            const token = await login(wallet, nonce);
            tokens[wallet.address] = token;
            log('Đăng nhập thành công!', 'success');

            const user_info = await get_user_info(wallet, token);
            log(`Điểm Taker: ${user_info.takerPoints} | Lượt đăng nhập liên tiếp: ${user_info.consecutiveSignInCount} | Số thưởng: ${user_info.rewardCount}`, 'info');

            if (user_info.nextTimestamp && user_info.nextTimestamp <= Date.now()) {
                log('Chu kỳ farming hoàn tất. Nhận thưởng...', 'info');
                await farm_cycle(wallet, token, captchaService);
            } else if (user_info.nextTimestamp && user_info.nextTimestamp > Date.now()) {
                log(`Đang farming. Nhận thưởng sau: ${format_time(user_info.nextTimestamp)}`, 'info');
                start_countdown(wallet, token, user_info.nextTimestamp, captchaService);
            } else {
                log('Không có farming hoạt động. Bắt đầu farming...', 'info');
                const sign_in_success = await sign_in(wallet, token);
                if (sign_in_success) {
                    const updated_info = await get_user_info(wallet, token);
                    if (updated_info.nextTimestamp) start_countdown(wallet, token, updated_info.nextTimestamp, captchaService);
                }
            }
        } catch (error) {
            log(`Lỗi: ${error.message}`, 'error');
        }
    }
}

async function run() {
    try {
        const captchaService = await selectCaptchaService();
        await process_wallets(captchaService);
        log('Bắt đầu chế độ chờ và lặp lại sau 3 giờ...', 'info');
        setInterval(async () => {
            log('Bắt đầu chu kỳ mới...', 'success');
            await process_wallets(captchaService);
        }, 3 * 60 * 60 * 1000); // 3 giờ
    } catch (error) {
        log(`Lỗi khởi động bot: ${error.message}`, 'error');
        rl.close();
        process.exit(1);
    }
}

run();
