"use strict";

// 定義常數
const OFFLINE_DATA_FILE = "offline.js"; // 定義離線時使用的數據文件名
const CACHE_NAME_PREFIX = "c2offline"; // 快取名稱的前綴
const BROADCASTCHANNEL_NAME = "offline"; // 廣播頻道的名稱
const CONSOLE_PREFIX = "[SW] "; // 用於控制台日誌的前綴
const LAZYLOAD_KEYNAME = ""; // 懶加載鍵名，目前為空

// 如果支援，則建立一個 BroadcastChannel
const broadcastChannel = (typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(BROADCASTCHANNEL_NAME));

//////////////////////////////////////
// 實用方法區
function PostBroadcastMessage(o)
{
    // 如果不支援 BroadcastChannel，則直接返回
	if (!broadcastChannel)
		return;

    // 引入人為（且任意！）的延遲 3 秒，以確保客戶端在發送訊息時已經在聆聽
    // 注意：我們可以在某些消息上移除這個延遲，但這樣可能會造成競態條件，即消息有時可能會以錯誤的順序到達
    // （例如，“更新準備好了”可能會在“開始下載更新”之前到達）。因此，為了保持一致的順序，對所有消息延遲相同的時間。
	setTimeout(() => broadcastChannel.postMessage(o), 3000);
};

function Broadcast(type)
{
    // 發送特定類型的廣播消息
	PostBroadcastMessage({ "type": type });
};

function BroadcastDownloadingUpdate(version)
{
    // 發送正在下載更新的廣播消息
	PostBroadcastMessage({
		"type": "downloading-update",
		"version": version
	});
}

function BroadcastUpdateReady(version)
{
    // 發送更新準備就緒的廣播消息
	PostBroadcastMessage({
		"type": "update-ready",
		"version": version
	});
}

function IsUrlInLazyLoadList(url, lazyLoadList)
{
    // 如果懶加載列表不存在，可能是加載失敗，返回 false
	if (!lazyLoadList)
		return false;
	
	try {
	    // 對於列表中的每個正則表達式，檢查它是否匹配 URL
		for (const lazyLoadRegex of lazyLoadList)
		{
			if (new RegExp(lazyLoadRegex).test(url))
				return true; // 匹配成功
		}
	}
	catch (err)
	{
	    // 如果正則表達式匹配出錯，則在控制台輸出錯誤信息
		console.error(CONSOLE_PREFIX + "Error matching in lazy-load list: ", err);
	}
	
	return false; // 沒有匹配項目
};

function WriteLazyLoadListToStorage(lazyLoadList)
{
    // 如果 localforage 沒有被導入，則直接返回一個已解決的 Promise，跳過存儲操作
	if (typeof localforage === "undefined")
		return Promise.resolve();
	else
		return localforage.setItem(LAZYLOAD_KEYNAME, lazyLoadList); // 否則，將懶加載列表寫入存儲
};

function ReadLazyLoadListFromStorage()
{
    // 如果 localforage 沒有被導入，則返回一個解析為空陣列的 Promise，跳過讀取操作
	if (typeof localforage === "undefined")
		return Promise.resolve([]);
	else
		return localforage.getItem(LAZYLOAD_KEYNAME); // 否則，從存儲中讀取懶加載列表
};

function GetCacheBaseName()
{
    // 包括範圍以避免與同一來源下的其他 Service Workers 的名稱衝突。
    // 例如 "c2offline-https://example.com/foo/"（不會與 bar/ 下的任何東西衝突）
    return CACHE_NAME_PREFIX + "-" + self.registration.scope;
};

function GetCacheVersionName(version)
{
    // 在快取名稱後附加版本號。
    // 例如 "c2offline-https://example.com/foo/-v2"
    return GetCacheBaseName() + "-v" + version;
};

// 返回只包含我們感興趣的快取（具有正確基礎名稱）的 caches.keys() 篩選結果。
// 這樣可以過濾掉與其他範圍無關的快取。
async function GetAvailableCacheNames()
{
    const cacheNames = await caches.keys();
    const cacheBaseName = GetCacheBaseName();
    return cacheNames.filter(n => n.startsWith(cacheBaseName));
};

// 確定是否有更新待定，當我們有兩個或更多可用快取時即為此情況。
// 必須有一個是等待的更新，因為下一次導航進行升級時會刪除所有舊快取，只留下當前使用的快取。
async function IsUpdatePending()
{
    const availableCacheNames = await GetAvailableCacheNames();
    return (availableCacheNames.length >= 2);
};

// 從可用的瀏覽器窗口自動推斷主頁面 URL（例如 index.html 或 main.aspx）。
// 這避免了在文件列表中硬編碼一個索引頁面，像 AppCache 那樣隱式快取它。
async function GetMainPageUrl()
{
    const allClients = await clients.matchAll({
        includeUncontrolled: true,
        type: "window"
    });
    
    for (const c of allClients)
    {
        // 從完整的客戶端 URL 中解析出範圍，例如 https://example.com/index.html -> index.html
        let url = c.url;
        if (url.startsWith(self.registration.scope))
            url = url.substring(self.registration.scope.length);
        
        if (url && url !== "/") // ./ 也被隱式快取，所以不需要返回這個
        {
            // 如果 URL 僅是一個查詢字串，為了確保正確快取，請在前面加上 /。
            // 例如 https://example.com/?foo=bar 需要快取為 /?foo=bar，而不僅僅是 ?foo=bar。
            if (url.startsWith("?"))
                url = "/" + url;
            
            return url;
        }
    }
    
    return ""; // 無法識別出主頁面 URL
};

// 繞過 HTTP 快取的臨時方案，直到 Chrome 支援 fetch 快取選項（crbug.com/453190）
function fetchWithBypass(request, bypassCache)
{
    // 如果 request 是字串，則將其轉換為 Request 物件
    if (typeof request === "string")
        request = new Request(request);
    
    if (bypassCache)
    {
        // 啟用繞過：添加一個隨機查詢參數來避免獲得過時的 HTTP 快取結果
        const url = new URL(request.url);
        url.search += Math.floor(Math.random() * 1000000);

        return fetch(url, {
            headers: request.headers,
            mode: request.mode,
            credentials: request.credentials,
            redirect: request.redirect,
            cache: "no-store" // 不使用快取
        });
    }
    else
    {
        // 繞過未啟用：執行正常的 fetch，允許從 HTTP 快取中返回
        return fetch(request);
    }
};

// 實質上是一個只有在所有請求都成功時才創建快取的 cache.addAll()，
// 並且可以選擇性地在每個請求中使用 fetchWithBypass 進行快取繞過
async function CreateCacheFromFileList(cacheName, fileList, bypassCache)
{
    // 同時啟動所有請求並等待它們全部完成
    const responses = await Promise.all(fileList.map(url => fetchWithBypass(url, bypassCache)));
    
    // 檢查是否有任何請求失敗。若有，則不進行開啟快取。
    // 這確保我們只在所有請求都成功時才開啟快取。
    let allOk = true;
    
    for (const response of responses)
    {
        if (!response.ok)
        {
            allOk = false;
            console.error(CONSOLE_PREFIX + "Error fetching '" + response.url + "' (" + response.status + " " + response.statusText + ")");
        }
    }
    
    if (!allOk)
        throw new Error("not all resources were fetched successfully");
    
    // 現在可以假設所有回應都是 OK 的。開啟一個快取並將所有回應寫入其中。
    // TODO: 理想情況下我們可以交易性地做這件事，以確保完整的快取被寫入為一個原子操作。
    // 這需要規範中的新交易功能，或者至少是重命名快取的方法
    // （這樣我們可以寫入一個暫時名稱，該名稱不會被 GetAvailableCacheNames() 返回，然後在準備好時重命名它）。
    const cache = await caches.open(cacheName);
    
    try {
        return await Promise.all(responses.map(
            (response, i) => cache.put(fileList[i], response)
        ));
    }
    catch (err)
    {
        // 不確定為什麼 cache.put() 會失敗（也許是超過存儲配額？）但如果發生，
        // 清理快取以嘗試避免留下不完整的快取。
        console.error(CONSOLE_PREFIX + "Error writing cache entries: ", err);
        caches.delete(cacheName);
        throw err;
    }
};

async function UpdateCheck(isFirst)
{
	try {
	    // 在請求 offline.js 時總是繞過快取，以確保我們能找出新的版本。
		const response = await fetchWithBypass(OFFLINE_DATA_FILE, true);
		
		if (!response.ok)
			throw new Error(OFFLINE_DATA_FILE + " 回應了 " + response.status + " " + response.statusText);
			
		const data = await response.json();
		
		const version = data.version; // 從回應中獲取版本號
		const fileList = data.fileList; // 從回應中獲取文件列表
		const lazyLoadList = data.lazyLoad; // 從回應中獲取懶加載列表
		const currentCacheName = GetCacheVersionName(version); // 獲取當前快取名稱
		
		const cacheExists = await caches.has(currentCacheName);

		// 如果這個版本的快取已經存在，則不重新快取。假設它是完整的。
		if (cacheExists)
		{
			// 記錄我們是否已經更新或等待更新。
			const isUpdatePending = await IsUpdatePending();
			if (isUpdatePending)
			{
				console.log(CONSOLE_PREFIX + "更新待定");
				Broadcast("update-pending");
			}
			else
			{
				console.log(CONSOLE_PREFIX + "已是最新狀態");
				Broadcast("up-to-date");
			}
			return;
		}
		
		// 隱式地將主頁面 URL 添加到文件列表中，例如 "index.html"，這樣我們就不需要假設一個特定的名稱。
		const mainPageUrl = await GetMainPageUrl();
		
		// 如果我們找到了主頁面 URL 且它尚未在列表中，則將其添加到文件列表的開頭。
		// 也確保我們請求基本路徑 /，它應該服務於主頁面。
		fileList.unshift("./");
		
		if (mainPageUrl && fileList.indexOf(mainPageUrl) === -1)
			fileList.unshift(mainPageUrl);
		
		console.log(CONSOLE_PREFIX + "快取 " + fileList.length + " 個文件以供離線使用");
		
		if (isFirst)
			Broadcast("downloading");
		else
			BroadcastDownloadingUpdate(version);
		
		// 注意，在第一次更新檢查時我們不繞過快取。這是因為 SW 安裝和接下來的更新檢查快取會與正常頁面加載請求競爭。
		// 對於已經完成或正在進行中的普通加載 fetch，破壞快取以進行離線快取是無意義且浪費的，因為這會強制發出第二個網絡請求，
		// 當來自瀏覽器 HTTP 快取的回應就可以了。
		if (lazyLoadList)
			await WriteLazyLoadListToStorage(lazyLoadList); // 將懶加載列表傾卸到本地存儲#
		
		await CreateCacheFromFileList(currentCacheName, fileList, !isFirst);
		const isUpdatePending = await IsUpdatePending();
		
		if (isUpdatePending)
		{
			console.log(CONSOLE_PREFIX + "所有資源已保存，更新準備就緒");
			BroadcastUpdateReady(version);
		}
		else
		{
			console.log(CONSOLE_PREFIX + "所有資源已保存，離線支援準備就緒");
			Broadcast("offline-ready");
		}
	}
	catch (err)
	{
		// 更新檢查的 fetch 在我們離線時會失敗，但如果出現任何其他類型的問題，則記錄一個警告。
		console.warn(CONSOLE_PREFIX + "更新檢查失敗：", err);
	}
};

// 監聽 Service Worker 的安裝事件
self.addEventListener("install", event =>
{
	// 在安裝時開始一次更新檢查，以便在首次使用時快取文件。
	// 如果失敗，我們仍然可以完成安裝事件並保持 SW 運行，我們將在下一次導航時重試。
	event.waitUntil(
		UpdateCheck(true)		// 首次更新
		.catch(() => null)      // 發生錯誤時忽略
	);
});

// 獲取要使用的快取名稱
async function GetCacheNameToUse(availableCacheNames, doUpdateCheck)
{
	// 優先選擇最舊的可用快取。這樣可以避免混合版本的回應，確保如果在頁面運行期間由於更新檢查而創建並填充了新的快取，
	// 我們只從原始（最舊的）快取返回資源。
	if (availableCacheNames.length === 1 || !doUpdateCheck)
		return availableCacheNames[0];
	
	// 如果有一個導航請求且有多個快取可用，檢查我們是否可以過期任何舊的快取。
	const allClients = await clients.matchAll();
	
	// 如果還有其他客戶端打開，暫時不過期任何東西。我們不想刪除它們可能正在使用的任何快取，
	// 因為這可能導致混合版本的回應。
	if (allClients.length > 1)
		return availableCacheNames[0];
	
	// 確定要使用的最新快取。刪除所有其他快取。
	const latestCacheName = availableCacheNames[availableCacheNames.length - 1];
	console.log(CONSOLE_PREFIX + "更新到新版本");
	
	await Promise.all(
		availableCacheNames.slice(0, -1)
		.map(c => caches.delete(c))
	);
	
	return latestCacheName;
};

// 處理 fetch 事件
async function HandleFetch(event, doUpdateCheck)
{
	const availableCacheNames = await GetAvailableCacheNames();
	
	// 如果沒有可用的快取：轉到網路
	if (!availableCacheNames.length)
		return fetch(event.request);
	
	const useCacheName = await GetCacheNameToUse(availableCacheNames, doUpdateCheck);
	const cache = await caches.open(useCacheName);
	const cachedResponse = await cache.match(event.request);
	
	if (cachedResponse)
		return cachedResponse;		// 使用快取的回應
	
	// 我們需要檢查這個請求是否應該被懶加載快取。同時發送請求並從存儲中加載懶加載列表。
	const result = await Promise.all([fetch(event.request), ReadLazyLoadListFromStorage()]);
	const fetchResponse = result[0];
	const lazyLoadList = result[1];
	
	if (IsUrlInLazyLoadList(event.request.url, lazyLoadList))
	{
		// 處理寫入快取失敗的情況。這可能發生在超過存儲配額時，特別是在 Safari 11.1 中，它似乎有非常嚴格的存儲限制。
		// 確保即使在出錯的情況下，我們繼續返回 fetch 的回應。
		try {
			// 注意克隆回應，因為我們也會用它來回應
			await cache.put(event.request, fetchResponse.clone());
		}
		catch (err)
		{
			console.warn(CONSOLE_PREFIX + "快取 '" + event.request.url + "' 時出錯: ", err);
		}
	}
		
	return fetchResponse;
};

// 監聽 Service Worker 的 fetch 事件
self.addEventListener("fetch", event =>
{
	/** 註釋（iain）
	 *  這個檢查是為了防止 XMLHttpRequest 的一個錯誤，其中如果它
	 *  通過 "FetchEvent.prototype.respondWith" 進行代理，則不會觸發上傳進度
	 *  事件。通過返回，我們允許發生默認動作。目前所有跨域請求都回退到默認。
	 */
	if (new URL(event.request.url).origin !== location.origin)
		return;
		
	// 對導航請求進行更新檢查
	const doUpdateCheck = (event.request.mode === "navigate");
	
	// 調用 HandleFetch 函數來處理 fetch 請求
	const responsePromise = HandleFetch(event, doUpdateCheck);

	if (doUpdateCheck)
	{
		// 允許主要請求完成，然後檢查更新
		event.waitUntil(
			responsePromise
			.then(() => UpdateCheck(false))	 // 非首次檢查
		);
	}

	// 使用來自 HandleFetch 的回應或請求的回應來回應 fetch 事件
	event.respondWith(responsePromise);
});
