/* 团队端点（docs/协同编辑.md §22.4）：一台电脑上起几台设备，按名单连成网、按 Presence 认人、
一篇的会话经主持人星形转发。不靠 mDNS：互相告诉地址（learn） */

use std::time::Duration;

use iroh::SecretKey;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

use super::*;

const TEAM: &str = "0123456789abcdef0123456789abcdef";
const DOC: &str = "笔记/周会.md";

struct Node {
    net: TeamNet,
    events: UnboundedReceiver<TeamEvent>,
}

async fn device() -> (TeamNet, SecretKey) {
    let key = SecretKey::generate();
    let net = TeamNet::start(TeamOptions {
        key: key.clone(),
        relays: Vec::new(),
        mdns: false,
        places_file: None,
    })
    .await
    .unwrap();
    (net, key)
}

fn listed(nets: &[&TeamNet]) -> Vec<Device> {
    nets.iter()
        .enumerate()
        .map(|(index, net)| Device {
            key: net.key(),
            account: format!("github:user{index}"),
            name: format!("设备{index}"),
        })
        .collect()
}

fn join(net: TeamNet, name: &str, devices: Vec<Device>) -> Node {
    let (tx, events) = unbounded_channel();
    net.join(
        TeamSpec {
            id: TEAM.into(),
            name: name.into(),
            account: format!("github:{name}"),
            devices,
            root: None,
        },
        tx,
    );
    Node { net, events }
}

/// 一组设备：都在名单里、互相知道地址
async fn team(names: &[&str]) -> Vec<Node> {
    let mut nets = Vec::new();
    for _ in names {
        nets.push(device().await.0);
    }
    let devices = listed(&nets.iter().collect::<Vec<_>>());
    let addrs: Vec<_> = nets.iter().map(TeamNet::addr).collect();
    let mut out: Vec<Node> = nets
        .into_iter()
        .zip(names)
        .map(|(net, name)| join(net, name, devices.clone()))
        .collect();
    for device in &mut out {
        for addr in &addrs {
            if *addr.id.as_bytes() != device.net.key() {
                device.net.learn(addr);
            }
        }
    }
    out
}

async fn until(what: &str, mut check: impl FnMut() -> bool) {
    for _ in 0..400 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("等不到：{what}");
}

/// 等到某个事件（之前的都扔掉）
async fn next(device: &mut Node, what: &str, mut wanted: impl FnMut(&TeamEvent) -> bool) -> TeamEvent {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let event = tokio::time::timeout_at(deadline, device.events.recv())
            .await
            .unwrap_or_else(|_| panic!("等不到：{what}"))
            .expect("事件通道关了");
        if wanted(&event) {
            return event;
        }
    }
}

/// a 那边给 b 的编号
fn member_of(a: &TeamNet, b: &TeamNet) -> u16 {
    let id = data_encoding::HEXLOWER.encode(&b.key());
    a.peers(TEAM).into_iter().find(|peer| peer.id == id).expect("名单里有").member
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn members_connect_and_see_each_others_presence() {
    let devices = team(&["张三", "李四", "王五"]).await;
    until("三台都连上", || devices.iter().all(|device| device.net.online(TEAM) == 2)).await;
    devices[0].net.set_presence(
        TEAM,
        vec![PresenceDoc {
            doc: DOC.into(),
            hosting: false,
            session: None,
        }],
    );
    let zhang = data_encoding::HEXLOWER.encode(&devices[0].net.key());
    until("李四看到张三开着周会", || {
        devices[1]
            .net
            .peers(TEAM)
            .iter()
            .any(|peer| peer.id == zhang && peer.online && peer.name == "张三" && peer.docs.iter().any(|doc| doc.doc == DOC))
    })
    .await;
    // 名单里的名字只是没连上时的；连上了用对方报的
    let li = devices[0].net.peers(TEAM);
    assert_eq!(li.len(), 2, "自己不在里面");
    assert!(li.iter().all(|peer| peer.online));
    for device in devices {
        device.net.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_device_not_in_the_list_is_refused() {
    let (a, _) = device().await;
    let (stranger, _) = device().await;
    // a 的名单里只有自己；外人的名单里有 a（他自己写的，a 还没同步到 —— 或者根本不是成员）
    let a_devices = listed(&[&a]);
    let stranger_devices = vec![a_devices[0].clone(), listed(&[&stranger])[0].clone()];
    let a_addr = a.addr();
    let a = join(a, "张三", a_devices.clone());
    let stranger = join(stranger, "外人", stranger_devices);
    stranger.net.learn(&a_addr);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(a.net.online(TEAM), 0);
    assert_eq!(stranger.net.online(TEAM), 0);
    // a 同步到了名单（外人那一行进来了）：下一轮就连上
    let mut both = a_devices;
    both.push(Device {
        key: stranger.net.key(),
        account: "github:stranger".into(),
        name: "外人".into(),
    });
    a.net.set_devices(TEAM, both);
    until("名单对上以后连上", || a.net.online(TEAM) == 1 && stranger.net.online(TEAM) == 1).await;
    a.net.stop().await;
    stranger.net.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_doc_session_runs_through_the_host() {
    let mut devices = team(&["张三", "李四", "王五"]).await;
    until("三台都连上", || devices.iter().all(|device| device.net.online(TEAM) == 2)).await;
    let [a, b, c] = &mut devices[..] else { unreachable!() };

    // 没人主持：开不了，说为什么
    let host_for_b = member_of(&b.net, &a.net);
    b.net.open(TEAM, DOC, host_for_b).unwrap();
    let refused = next(b, "不给", |event| matches!(event, TeamEvent::DocClosed { .. })).await;
    assert!(matches!(refused, TeamEvent::DocClosed { refused: Some(_), .. }), "{refused:?}");

    // 张三主持；李四、王五开
    a.net.host(TEAM, DOC, true);
    b.net.open(TEAM, DOC, host_for_b).unwrap();
    next(b, "李四接上", |event| matches!(event, TeamEvent::SyncStart { doc, .. } if doc == DOC)).await;
    let b_on_a = member_of(&a.net, &b.net);
    next(a, "张三这边李四进来", |event| matches!(event, TeamEvent::SyncStart { with, .. } if *with == b_on_a)).await;
    let host_for_c = member_of(&c.net, &a.net);
    c.net.open(TEAM, DOC, host_for_c).unwrap();
    next(c, "王五接上", |event| matches!(event, TeamEvent::SyncStart { .. })).await;
    let c_on_a = member_of(&a.net, &c.net);
    next(a, "张三这边王五进来", |event| matches!(event, TeamEvent::SyncStart { with, .. } if *with == c_on_a)).await;

    // 同步消息点对点
    b.net.send_sync(TEAM, host_for_b, DOC, SyncKind::Vector, b"sv-b".to_vec());
    let request = next(a, "李四的状态向量", |event| matches!(event, TeamEvent::SyncRequest { .. })).await;
    assert_eq!(
        request,
        TeamEvent::SyncRequest {
            from: b_on_a,
            doc: DOC.into(),
            vector: b"sv-b".to_vec(),
        }
    );
    a.net.send_sync(TEAM, b_on_a, DOC, SyncKind::Reply, b"missing".to_vec());
    let reply = next(b, "张三回的", |event| matches!(event, TeamEvent::Update { .. })).await;
    assert_eq!(
        reply,
        TeamEvent::Update {
            from: host_for_b,
            doc: DOC.into(),
            bytes: b"missing".to_vec(),
        }
    );

    // 李四的更新：张三收到，也转给王五
    b.net.send_update(TEAM, DOC, b"from-b".to_vec());
    let at_a = next(a, "张三收到李四的", |event| matches!(event, TeamEvent::Update { .. })).await;
    assert!(matches!(at_a, TeamEvent::Update { from, bytes, .. } if from == b_on_a && bytes == b"from-b"));
    let at_c = next(c, "王五收到李四的（经张三）", |event| matches!(event, TeamEvent::Update { .. })).await;
    assert!(matches!(at_c, TeamEvent::Update { bytes, .. } if bytes == b"from-b"));
    // 张三的更新两位都收到
    a.net.send_update(TEAM, DOC, b"from-a".to_vec());
    next(b, "李四收到张三的", |event| matches!(event, TeamEvent::Update { bytes, .. } if bytes == b"from-a")).await;
    next(c, "王五收到张三的", |event| matches!(event, TeamEvent::Update { bytes, .. } if bytes == b"from-a")).await;

    // 光标：李四的经张三到王五，王五认得出是李四
    let b_on_c = member_of(&c.net, &b.net);
    let mut seen_at_c = false;
    for _ in 0..40 {
        b.net.send_cursor(TEAM, DOC, b"caret");
        tokio::time::sleep(Duration::from_millis(50)).await;
        while let Ok(event) = c.events.try_recv() {
            if event
                == (TeamEvent::Cursor {
                    from: b_on_c,
                    doc: DOC.into(),
                    bytes: b"caret".to_vec(),
                })
            {
                seen_at_c = true;
            }
        }
        if seen_at_c {
            break;
        }
    }
    assert!(seen_at_c, "王五没收到李四的光标");

    // 李四关掉：张三那边知道
    b.net.close(TEAM, DOC);
    next(a, "李四走了", |event| matches!(event, TeamEvent::DocClosed { member, .. } if *member == b_on_a)).await;
    // 张三不主持了：王五那边断了（不是被拒）
    a.net.host(TEAM, DOC, false);
    let closed = next(c, "主持人不主持了", |event| matches!(event, TeamEvent::DocClosed { .. })).await;
    assert!(matches!(closed, TeamEvent::DocClosed { refused: None, .. }), "{closed:?}");

    for device in devices {
        device.net.stop().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_dropped_link_closes_the_doc_and_comes_back() {
    let mut devices = team(&["张三", "李四"]).await;
    until("连上", || devices.iter().all(|device| device.net.online(TEAM) == 1)).await;
    let [a, b] = &mut devices[..] else { unreachable!() };
    a.net.host(TEAM, DOC, true);
    let host = member_of(&b.net, &a.net);
    b.net.open(TEAM, DOC, host).unwrap();
    next(b, "接上", |event| matches!(event, TeamEvent::SyncStart { .. })).await;
    // 张三那边的窗口重新载入（同一个团队再登记一次）：连接断开、重连
    let devices_a = listed(&[&a.net, &b.net]);
    let (tx, events) = unbounded_channel();
    a.net.join(
        TeamSpec {
            id: TEAM.into(),
            name: "张三".into(),
            account: "github:zhang".into(),
            devices: devices_a,
            root: None,
        },
        tx,
    );
    a.events = events;
    let closed = next(b, "断了", |event| matches!(event, TeamEvent::DocClosed { .. })).await;
    assert!(matches!(closed, TeamEvent::DocClosed { refused: None, .. }));
    until("又连上了", || a.net.online(TEAM) == 1 && b.net.online(TEAM) == 1).await;
    for device in devices {
        device.net.stop().await;
    }
}
