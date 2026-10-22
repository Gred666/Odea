//! 协作网络层的测试。后半部分在同一个进程里起真的 iroh 端点（走本机回环，不开 mDNS、
//! 不碰路由器），把主持人、访客从加入到离开整个走一遍；中继的那几个在进程里起一台真的
//! iroh-relay（自签名证书，按指纹认）。

use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;

use iroh::SecretKey;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

use super::protocol::{self, kind, Permission, RejectReason};
use super::*;

/* ---------------- 帧 ---------------- */

#[tokio::test]
async fn frames_round_trip_and_end_cleanly() {
    let (mut a, mut b) = tokio::io::duplex(1 << 20);
    let big = vec![7u8; 300_000];
    protocol::write_frame(&mut a, kind::UPDATE, b"hello")
        .await
        .unwrap();
    protocol::write_frame(&mut a, kind::OPEN, b"note-1")
        .await
        .unwrap();
    protocol::write_frame(&mut a, kind::SYNC2, &big)
        .await
        .unwrap();
    protocol::write_frame(&mut a, 200, b"future").await.unwrap();
    drop(a);
    assert_eq!(
        protocol::read_frame(&mut b).await.unwrap(),
        Some((kind::UPDATE, b"hello".to_vec()))
    );
    assert_eq!(
        protocol::read_frame(&mut b).await.unwrap(),
        Some((kind::OPEN, b"note-1".to_vec()))
    );
    assert_eq!(
        protocol::read_frame(&mut b).await.unwrap(),
        Some((kind::SYNC2, big))
    );
    // 认不出的类型照样读出来，由上层跳过
    assert_eq!(
        protocol::read_frame(&mut b).await.unwrap(),
        Some((200, b"future".to_vec()))
    );
    // 两帧之间正常结束
    assert_eq!(protocol::read_frame(&mut b).await.unwrap(), None);
}

#[tokio::test]
async fn frames_cut_in_the_middle_and_oversized_ones_are_errors() {
    let (mut a, mut b) = tokio::io::duplex(1024);
    // 声称 100 字节，只给 3 个就断了
    tokio::io::AsyncWriteExt::write_all(&mut a, &[100, kind::UPDATE, 1, 2])
        .await
        .unwrap();
    drop(a);
    assert!(protocol::read_frame(&mut b).await.is_err());

    let (mut a, mut b) = tokio::io::duplex(1024);
    // 长度 64MB：不分配，直接报错
    tokio::io::AsyncWriteExt::write_all(&mut a, &[0x80, 0x80, 0x80, 0x20, kind::UPDATE])
        .await
        .unwrap();
    assert!(matches!(
        protocol::read_frame(&mut b).await,
        Err(protocol::FrameError::TooLarge(_))
    ));
}

#[test]
fn proof_is_bound_to_the_secret_and_the_connection() {
    let secret = [1u8; 32];
    let keying = [2u8; 32];
    let proof = protocol::proof(&secret, &keying);
    assert!(protocol::verify_proof(&secret, &keying, &proof));
    assert!(!protocol::verify_proof(&[9u8; 32], &keying, &proof));
    // 换一条连接（导出的密钥材料不一样）就不认了：截获了也没法重放
    assert!(!protocol::verify_proof(&secret, &[3u8; 32], &proof));
}

#[test]
fn cursor_datagrams_carry_the_member() {
    let tagged = protocol::tag_cursor(513, b"xy");
    assert_eq!(protocol::untag_cursor(&tagged), Some((513, &b"xy"[..])));
    assert_eq!(protocol::untag_cursor(&[1]), None);
}

/* ---------------- 邀请链接 ---------------- */

fn sample_invite() -> Invite {
    Invite {
        host: [5u8; 32],
        addrs: vec![
            SocketAddr::from((Ipv4Addr::new(192, 168, 1, 23), 51234)),
            "[fe80::1]:51234".parse().unwrap(),
        ],
        session: [6u8; 16],
        secret: [7u8; 32],
        permission: Permission::Edit,
        relay: None,
    }
}

#[test]
fn invite_links_round_trip_and_tolerate_chat_apps() {
    let invite = sample_invite();
    let link = invite.to_link();
    assert!(link.starts_with("odea://join/"));
    assert!(link.len() < 300, "链接太长：{}", link.len());
    assert_eq!(Invite::parse(&link).unwrap(), invite);
    // 前后空白、尖括号、大写、只粘了票据那一截
    assert_eq!(Invite::parse(&format!("  <{link}>\n")).unwrap(), invite);
    assert_eq!(
        Invite::parse(&link.to_uppercase().replace("ODEA://JOIN/", "odea://join/")).unwrap(),
        invite
    );
    assert_eq!(
        Invite::parse(link.trim_start_matches("odea://join/")).unwrap(),
        invite
    );
}

#[test]
fn broken_or_newer_links_say_why() {
    assert_eq!(
        Invite::parse("https://example.com"),
        Err(LinkError::Malformed)
    );
    assert_eq!(Invite::parse("odea://join/"), Err(LinkError::Malformed));
    let newer = format!(
        "odea://join/{}",
        data_encoding::BASE32_NOPAD
            .encode(&[3, 1, 2, 3])
            .to_lowercase()
    );
    assert_eq!(Invite::parse(&newer), Err(LinkError::TooNew));
}

/* ---------------- 两端实连 ---------------- */

const WAIT: Duration = Duration::from_secs(15);
/// 大多数测试只协作一篇：就是它（一篇的范围，访客进来就开它；主持人那边不问直接给）
const DOC: &str = "note-1";

/// 等一个满足条件的事件，中间别的跳过
async fn expect<T>(
    events: &mut UnboundedReceiver<Event>,
    what: &str,
    pick: impl FnMut(&Event) -> Option<T>,
) -> T {
    expect_within(events, what, WAIT, pick).await
}

async fn expect_within<T>(
    events: &mut UnboundedReceiver<Event>,
    what: &str,
    wait: Duration,
    mut pick: impl FnMut(&Event) -> Option<T>,
) -> T {
    tokio::time::timeout(wait, async {
        loop {
            let event = events.recv().await.expect("事件通道关了");
            if let Some(value) = pick(&event) {
                return value;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("等不到：{what}"))
}

/// 一段时间里没有满足条件的事件
async fn expect_none(
    events: &mut UnboundedReceiver<Event>,
    what: &str,
    pick: impl Fn(&Event) -> bool,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(600);
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, events.recv()).await {
        assert!(!pick(&event), "不该出现：{what}：{event:?}");
    }
}

fn status_of(event: &Event) -> Option<Status> {
    match event {
        Event::Control(Control::Status { status }) => Some(status.clone()),
        _ => None,
    }
}

fn members_of(event: &Event) -> Option<Vec<MemberInfo>> {
    match event {
        Event::Control(Control::Members { members }) => Some(members.clone()),
        _ => None,
    }
}

async fn start_host(title: &str) -> (Host, UnboundedReceiver<Event>) {
    let (events, rx) = unbounded_channel();
    let host = Host::start(
        HostOptions {
            secret_key: SecretKey::generate(),
            name: "林夕".into(),
            title: title.into(),
            permission: Permission::Edit,
            mdns: false,
            relays: Vec::new(),
            portmap: false,
            firewall: false,
            note: String::new(),
            scope: protocol::Scope::doc(DOC, title),
            record: None,
            resume: None,
            trusted: Default::default(),
        },
        events,
    )
    .await
    .expect("主持人起不来");
    host.allow_docs(&[DOC]);
    (host, rx)
}

/// 单测里只走本机回环（局域网地址在 CI、沙箱里不一定通）
fn loopback(host: &Host, mut invite: Invite) -> Invite {
    invite.addrs = host
        .bound_sockets()
        .into_iter()
        .filter(|addr| addr.is_ipv4())
        .map(|addr| SocketAddr::from((Ipv4Addr::LOCALHOST, addr.port())))
        .collect();
    invite
}

async fn join(name: &str, invite: Invite) -> (Guest, UnboundedReceiver<Event>) {
    let (events, rx) = unbounded_channel();
    let guest = Guest::join(
        GuestOptions {
            secret_key: SecretKey::generate(),
            name: name.into(),
            invite,
            mdns: false,
            use_host_relay: true,
            relays: Vec::new(),
            portmap: false,
            nearby: false,
        },
        events,
    )
    .await
    .expect("访客起不来");
    (guest, rx)
}

/// 加入并被主持人允许，返回访客拿到的成员号
async fn admitted(
    host: &Host,
    host_events: &mut UnboundedReceiver<Event>,
    name: &str,
    permission: Permission,
) -> (Guest, UnboundedReceiver<Event>, u16) {
    let (guest, mut events) = join(name, loopback(host, host.invite())).await;
    let request = expect(host_events, "加入请求", |event| match event {
        Event::Control(Control::JoinRequest {
            request,
            name: who,
            invited,
            ..
        }) if who == name => {
            assert!(invited);
            Some(*request)
        }
        _ => None,
    })
    .await;
    assert!(host.answer(request, Decision::Allow(permission)));
    let member = expect(&mut events, "进来了", |event| match status_of(event) {
        Some(Status::Connected {
            member,
            permission: got,
            ..
        }) => {
            assert_eq!(got, permission);
            Some(member)
        }
        _ => None,
    })
    .await;
    // 双方都被叫去发 Sync1
    expect(&mut events, "访客的 SyncStart", |event| {
        matches!(event, Event::SyncStart { with: 0, .. }).then_some(())
    })
    .await;
    expect(host_events, "主持人的 SyncStart", |event| {
        matches!(event, Event::SyncStart { with, .. } if *with == member).then_some(())
    })
    .await;
    (guest, events, member)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn default_endpoint_talks_to_no_server() {
    let (host, _events) = start_host("t").await;
    // 没有中继：地址里只有直连的 IP
    let invite = host.invite();
    assert!(!host.bound_sockets().is_empty());
    assert!(invite.addrs.iter().all(|addr| addr.port() != 0));
    assert!(host.relays_disabled());
    host.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn join_confirm_sync_forward_and_leave() {
    let (host, mut host_events) = start_host("周会记录").await;
    let (guest, mut guest_events, member) =
        admitted(&host, &mut host_events, "Alex", Permission::Edit).await;
    assert_eq!(member, 1);

    // 访客这边的状态按顺序：连接中 → 等确认 → 已连上（上面 admitted 里已经等到了已连上）
    // 成员表两边一致
    let members = host.members();
    assert_eq!(members.len(), 2);
    assert_eq!(members[1].name, "Alex");

    // 同步：访客发 Sync1 → 主持人前端收到请求 → 回 Sync2 → 访客收到
    guest.send_sync(DOC, SyncKind::Vector, b"guest-sv".to_vec());
    expect(&mut host_events, "同步请求", |event| match event {
        Event::SyncRequest { from: 1, vector, .. } => {
            assert_eq!(vector, b"guest-sv");
            Some(())
        }
        _ => None,
    })
    .await;
    host.send_sync(1, DOC, SyncKind::Reply, b"snapshot".to_vec());
    expect(&mut guest_events, "快照", |event| {
        matches!(event, Event::Update { from: 0, bytes, .. } if bytes == b"snapshot").then_some(())
    })
    .await;

    // 实时更新两个方向
    host.send_update(DOC, b"from-host".to_vec());
    expect(&mut guest_events, "主持人的更新", |event| {
        matches!(event, Event::Update { from: 0, bytes, .. } if bytes == b"from-host").then_some(())
    })
    .await;
    guest.send_update(DOC, b"from-guest".to_vec());
    expect(&mut host_events, "访客的更新", |event| {
        matches!(event, Event::Update { from: 1, bytes, .. } if bytes == b"from-guest").then_some(())
    })
    .await;

    // 光标走数据报（可能丢：一直发到收到为止）
    let got = tokio::time::timeout(WAIT, async {
        loop {
            guest.send_cursor(DOC, b"caret");
            tokio::time::sleep(Duration::from_millis(50)).await;
            while let Ok(event) = host_events.try_recv() {
                if matches!(&event, Event::Cursor { from: 1, bytes, .. } if bytes == b"caret") {
                    return;
                }
            }
        }
    })
    .await;
    assert!(got.is_ok(), "主持人收不到访客的光标");

    // 第二位访客（只读）：成员表三个人；第一位访客的更新转给他；他的更新被丢掉
    let (reader, mut reader_events, reader_member) =
        admitted(&host, &mut host_events, "佐藤", Permission::Read).await;
    assert_eq!(reader_member, 2);
    expect(
        &mut guest_events,
        "第一位访客看到三个人",
        |event| {
            members_of(event)
                .filter(|members| members.len() == 3)
                .map(|_| ())
        },
    )
    .await;
    guest.send_update(DOC, b"forwarded".to_vec());
    expect(&mut reader_events, "转发的更新", |event| {
        matches!(event, Event::Update { from: 0, bytes, .. } if bytes == b"forwarded").then_some(())
    })
    .await;
    reader.send_update(DOC, b"read-only".to_vec());
    expect_none(
        &mut host_events,
        "只读成员的更新",
        |event| matches!(event, Event::Update { bytes, .. } if bytes == b"read-only"),
    )
    .await;
    expect_none(
        &mut guest_events,
        "只读成员的更新",
        |event| matches!(event, Event::Update { bytes, .. } if bytes == b"read-only"),
    )
    .await;
    // 只读成员的光标照转（带着他的成员号）
    let got = tokio::time::timeout(WAIT, async {
        loop {
            reader.send_cursor(DOC, b"reader-caret");
            tokio::time::sleep(Duration::from_millis(50)).await;
            while let Ok(event) = guest_events.try_recv() {
                if matches!(&event, Event::Cursor { from: 2, bytes, .. } if bytes == b"reader-caret") {
                    return;
                }
            }
        }
    })
    .await;
    assert!(got.is_ok(), "转发的光标没带上成员号");

    // 改成能编辑：他自己收到通知，更新也不再被丢
    host.set_permission(2, Permission::Edit);
    expect(&mut reader_events, "权限通知", |event| {
        matches!(
            event,
            Event::Control(Control::Permission {
                permission: Permission::Edit
            })
        )
        .then_some(())
    })
    .await;
    reader.send_update(DOC, b"now-editing".to_vec());
    expect(&mut host_events, "改了权限之后的更新", |event| {
        matches!(event, Event::Update { from: 2, bytes, .. } if bytes == b"now-editing").then_some(())
    })
    .await;

    // 第二位访客离开：主持人那边成员表少一个
    reader.leave().await;
    expect(&mut host_events, "离开后的成员表", |event| {
        members_of(event)
            .filter(|members| members.len() == 2)
            .map(|_| ())
    })
    .await;

    // 主持人停止：访客知道是主持人停的
    host.stop().await;
    let reason = expect(&mut guest_events, "结束", |event| {
        match status_of(event) {
            Some(Status::Ended { reason }) => Some(reason),
            _ => None,
        }
    })
    .await;
    assert_eq!(reason, EndReason::HostStopped);
    drop(guest);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn declined_wrong_and_reset_links_are_turned_away() {
    let (host, mut host_events) = start_host("t").await;

    // 主持人拒绝
    let (_declined, mut events) = join("路人", loopback(&host, host.invite())).await;
    expect(&mut events, "等确认", |event| {
        matches!(status_of(event), Some(Status::Waiting)).then_some(())
    })
    .await;
    let request = expect(&mut host_events, "加入请求", |event| match event {
        Event::Control(Control::JoinRequest { request, .. }) => Some(*request),
        _ => None,
    })
    .await;
    host.answer(request, Decision::Reject);
    let reason = expect(&mut events, "被拒", |event| match status_of(event) {
        Some(Status::Ended { reason }) => Some(reason),
        _ => None,
    })
    .await;
    assert_eq!(
        reason,
        EndReason::Rejected {
            reason: RejectReason::Declined
        }
    );

    // 密钥不对：不问主持人，直接拒
    let mut forged = loopback(&host, host.invite());
    forged.secret = [0u8; 32];
    let (_forged, mut events) = join("冒充", forged).await;
    let reason = expect(&mut events, "链接不对", |event| {
        match status_of(event) {
            Some(Status::Ended { reason }) => Some(reason),
            _ => None,
        }
    })
    .await;
    assert_eq!(
        reason,
        EndReason::Rejected {
            reason: RejectReason::BadInvite
        }
    );

    // 重置链接：旧链接作废
    let old = loopback(&host, host.invite());
    let fresh = loopback(&host, host.reset_invite());
    assert_ne!(old.secret, fresh.secret);
    let (_old, mut events) = join("拿着旧链接", old).await;
    let reason = expect(&mut events, "旧链接", |event| match status_of(event) {
        Some(Status::Ended { reason }) => Some(reason),
        _ => None,
    })
    .await;
    assert_eq!(
        reason,
        EndReason::Rejected {
            reason: RejectReason::BadInvite
        }
    );
    expect_none(&mut host_events, "被拒的不该问主持人", |event| {
        matches!(event, Event::Control(Control::JoinRequest { .. }))
    })
    .await;

    // 等确认时对方走了：请求撤掉
    let (waiting, _events) = join("等不及", loopback(&host, host.invite())).await;
    let request = expect(&mut host_events, "加入请求", |event| match event {
        Event::Control(Control::JoinRequest { request, .. }) => Some(*request),
        _ => None,
    })
    .await;
    waiting.leave().await;
    expect(&mut host_events, "请求撤掉", |event| {
        matches!(event, Event::Control(Control::JoinCancelled { request: r }) if *r == request)
            .then_some(())
    })
    .await;
    assert!(!host.answer(request, Decision::Allow(Permission::Edit)));
    host.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn kicked_guests_cannot_come_back() {
    let (host, mut host_events) = start_host("t").await;
    let invite = loopback(&host, host.invite());
    let (events_tx, mut events) = unbounded_channel();
    let key = SecretKey::generate();
    let _guest = Guest::join(
        GuestOptions {
            secret_key: key.clone(),
            name: "捣乱".into(),
            invite: invite.clone(),
            mdns: false,
            use_host_relay: true,
            relays: Vec::new(),
            portmap: false,
            nearby: false,
        },
        events_tx,
    )
    .await
    .unwrap();
    let request = expect(&mut host_events, "加入请求", |event| match event {
        Event::Control(Control::JoinRequest { request, .. }) => Some(*request),
        _ => None,
    })
    .await;
    host.answer(request, Decision::Allow(Permission::Edit));
    let member = expect(&mut events, "进来了", |event| match status_of(event) {
        Some(Status::Connected { member, .. }) => Some(member),
        _ => None,
    })
    .await;
    host.kick(member);
    let reason = expect(&mut events, "被移出", |event| match status_of(event) {
        Some(Status::Ended { reason }) => Some(reason),
        _ => None,
    })
    .await;
    assert_eq!(reason, EndReason::Kicked);

    // 同一台设备（同一把公钥）拿着链接再来：直接拒
    let (events_tx, mut events) = unbounded_channel();
    let _again = Guest::join(
        GuestOptions {
            secret_key: key,
            name: "捣乱".into(),
            invite,
            mdns: false,
            use_host_relay: true,
            relays: Vec::new(),
            portmap: false,
            nearby: false,
        },
        events_tx,
    )
    .await
    .unwrap();
    let reason = expect(&mut events, "再来", |event| match status_of(event) {
        Some(Status::Ended { reason }) => Some(reason),
        _ => None,
    })
    .await;
    assert_eq!(
        reason,
        EndReason::Rejected {
            reason: RejectReason::Kicked
        }
    );
    host.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropped_connections_reconnect_without_asking_again() {
    let (host, mut host_events) = start_host("t").await;
    let (guest, mut events, member) =
        admitted(&host, &mut host_events, "Alex", Permission::Read).await;

    // 网络断了一下（主持人这边把连接掐掉，不拉黑）
    host.drop_connection(member);
    expect(&mut events, "重新连接中", |event| {
        matches!(status_of(event), Some(Status::Reconnecting)).then_some(())
    })
    .await;
    // 重连上：不再问主持人，还是原来的成员号和权限，双方再同步一次
    let (again, permission) = expect(&mut events, "重连上", |event| match status_of(event) {
        Some(Status::Connected {
            member, permission, ..
        }) => Some((member, permission)),
        _ => None,
    })
    .await;
    assert_eq!((again, permission), (member, Permission::Read));
    expect(&mut events, "重连后的 SyncStart", |event| {
        matches!(event, Event::SyncStart { with: 0, .. }).then_some(())
    })
    .await;
    expect(&mut host_events, "主持人这边的 SyncStart", |event| {
        matches!(event, Event::SyncStart { with, .. } if *with == member).then_some(())
    })
    .await;
    expect_none(&mut host_events, "重连不该再问", |event| {
        matches!(event, Event::Control(Control::JoinRequest { .. }))
    })
    .await;
    host.send_update(DOC, b"after-reconnect".to_vec());
    expect(&mut events, "重连后的更新", |event| {
        matches!(event, Event::Update { from: 0, bytes, .. } if bytes == b"after-reconnect")
            .then_some(())
    })
    .await;
    guest.leave().await;
    host.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unreachable_hosts_get_a_conclusion_not_a_spinner() {
    let invite = Invite {
        host: *SecretKey::generate().public().as_bytes(),
        // 没有人在听的端口
        addrs: vec![SocketAddr::from((Ipv4Addr::LOCALHOST, 9))],
        session: [0; 16],
        secret: [0; 32],
        permission: Permission::Edit,
        relay: None,
    };
    let (guest, mut events) = join("x", invite).await;
    // 从端点建好算起（建端点本身要 2–3 秒，在 iroh 的网络监视初始化里）
    let started = tokio::time::Instant::now();
    let diagnosis = expect(&mut events, "连不上的结论", |event| {
        match status_of(event) {
            Some(Status::Unreachable { diagnosis }) => Some(diagnosis),
            Some(Status::Ended { reason }) => panic!("不该结束：{reason:?}"),
            _ => None,
        }
    })
    .await;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "3 秒该给结论，等了 {:?}",
        started.elapsed()
    );
    // 链接里是本机回环：同一台电脑，算同一个网络 → 连不进去多半是防火墙
    assert!(diagnosis.same_network);
    assert_eq!(diagnosis.cause, diagnose::Cause::Blocked);
    // 不算结束：后台接着试
    expect_none(&mut events, "连不上不该结束", |event| {
        matches!(status_of(event), Some(Status::Ended { .. }))
    })
    .await;
    guest.leave().await;
}

/* ---------------- 地址、诊断（纯函数） ---------------- */

#[test]
fn addresses_are_sorted_by_who_can_use_them() {
    use reach::{classify, link_addrs, AddrKind};
    let ip = |text: &str| text.parse::<std::net::IpAddr>().unwrap();
    assert_eq!(classify(ip("192.168.1.2")), AddrKind::Lan);
    assert_eq!(classify(ip("10.3.0.1")), AddrKind::Lan);
    assert_eq!(classify(ip("172.20.1.1")), AddrKind::Lan);
    assert_eq!(classify(ip("100.72.3.4")), AddrKind::Shared);
    assert_eq!(classify(ip("169.254.9.9")), AddrKind::LinkLocal);
    assert_eq!(classify(ip("58.33.10.2")), AddrKind::PublicV4);
    assert_eq!(classify(ip("127.0.0.1")), AddrKind::Loopback);
    assert_eq!(classify(ip("fe80::1")), AddrKind::LinkLocal);
    assert_eq!(classify(ip("fd12:3456::1")), AddrKind::Lan);
    assert_eq!(classify(ip("2408:8207:1234::1")), AddrKind::PublicV6);
    assert_eq!(classify(ip("::ffff:192.168.1.2")), AddrKind::Lan);
    // 文档用的示例地址不当公网
    assert_eq!(classify(ip("2001:db8::1")), AddrKind::Other);
    assert_eq!(classify(ip("203.0.113.5")), AddrKind::Other);
    // Clash / Mihomo 的 TUN 网卡（基准测试段 198.18.0.0/15），两头都不算公网
    assert_eq!(classify(ip("198.18.0.1")), AddrKind::Other);
    assert_eq!(classify(ip("198.19.255.254")), AddrKind::Other);
    assert_eq!(classify(ip("198.17.0.1")), AddrKind::PublicV4);
    assert_eq!(classify(ip("198.20.0.1")), AddrKind::PublicV4);

    let addr = |text: &str| text.parse::<SocketAddr>().unwrap();
    let sorted = link_addrs([
        addr("127.0.0.1:5"),
        addr("[fe80::1]:5"),
        addr("[2408:8207:1234::1]:5"),
        addr("58.33.10.2:7000"),
        addr("192.168.1.2:5"),
        addr("192.168.1.2:5"),
    ]);
    assert_eq!(
        sorted,
        vec![
            addr("58.33.10.2:7000"),
            addr("[2408:8207:1234::1]:5"),
            addr("192.168.1.2:5"),
            addr("127.0.0.1:5"),
        ]
    );
}

fn invite_to(addrs: &[&str], relay: Option<Relay>) -> Invite {
    Invite {
        host: [1; 32],
        addrs: addrs.iter().map(|addr| addr.parse().unwrap()).collect(),
        session: [2; 16],
        secret: [3; 32],
        permission: Permission::Edit,
        relay,
    }
}

#[test]
fn diagnosis_names_the_likely_cause() {
    use diagnose::{conclude, Cause, Facts, RelayFact};
    let net = |text: &str, prefix: u8| (text.parse::<std::net::IpAddr>().unwrap(), prefix);
    let home = Facts {
        networks: vec![net("192.168.1.50", 24)],
        ..Facts::default()
    };
    let cause = |invite: &Invite, facts: &Facts| conclude(invite, facts, true).cause;

    // 没网
    assert_eq!(
        cause(&invite_to(&["192.168.1.23:5"], None), &Facts::default()),
        Cause::Offline
    );
    // 同一个网段却连不进去：防火墙 / 客户端隔离
    let same = conclude(&invite_to(&["192.168.1.23:5"], None), &home, true);
    assert!(same.same_network);
    assert_eq!(same.cause, Cause::Blocked);
    // 不同网段、主持人只有局域网地址
    assert_eq!(
        cause(&invite_to(&["192.168.7.5:5"], None), &home),
        Cause::DifferentNetwork
    );
    // 网段对不上，但 mDNS 看到了：还是同一个网络
    let seen = Facts {
        seen_nearby: true,
        ..home.clone()
    };
    assert_eq!(
        cause(&invite_to(&["192.168.7.5:5"], None), &seen),
        Cause::Blocked
    );
    // 主持人只有公网 IPv6、我没有
    assert_eq!(
        cause(
            &invite_to(&["192.168.7.5:5", "[2408:8207::1]:5"], None),
            &home
        ),
        Cause::NoIpv6
    );
    // 我也有 IPv6：那就是对方不放行
    let with_v6 = Facts {
        networks: vec![net("192.168.1.50", 24), net("2409:8a00::9", 64)],
        ..Facts::default()
    };
    let firewalled = conclude(
        &invite_to(&["192.168.7.5:5", "[2408:8207::1]:5"], None),
        &with_v6,
        true,
    );
    assert!(firewalled.has_ipv6);
    assert_eq!(firewalled.cause, Cause::HostFirewalled);
    // 端口映射拿到的公网 IPv4 也连不进去
    assert_eq!(
        cause(
            &invite_to(&["192.168.7.5:5", "58.33.10.2:7000"], None),
            &home
        ),
        Cause::HostFirewalled
    );

    // 中继
    let relay = Relay::new("relay.example.com", Some("t".into()), None, None).unwrap();
    let via = invite_to(&["192.168.7.5:5"], Some(relay));
    let with_relay = |fact: RelayFact| Facts {
        relay: Some(fact),
        ..home.clone()
    };
    assert!(matches!(
        cause(&via, &with_relay(RelayFact::Denied("bad token".into()))),
        Cause::RelayDenied { .. }
    ));
    assert!(matches!(
        cause(&via, &with_relay(RelayFact::Failed("timeout".into()))),
        Cause::RelayDown { .. }
    ));
    assert_eq!(
        cause(&via, &with_relay(RelayFact::Outdated)),
        Cause::RelayOutdated
    );
    assert_eq!(
        cause(&via, &with_relay(RelayFact::Connected)),
        Cause::HostAway
    );
    // 中继还在连：先按直连说
    assert_eq!(
        cause(&via, &with_relay(RelayFact::Connecting)),
        Cause::DifferentNetwork
    );
    // 选了只直连：中继的事不提
    let direct = conclude(&via, &with_relay(RelayFact::Denied("x".into())), false);
    assert_eq!(direct.relay, None);
    assert_eq!(direct.cause, Cause::DifferentNetwork);
}

/* ---------------- 链接、中继码 ---------------- */

#[test]
fn relay_addresses_and_fingerprints_are_normalized() {
    let relay = Relay::new(
        "  Relay.Example.com/  ",
        Some("  tok  ".into()),
        Some("AB:".repeat(32).trim_end_matches(':')),
        Some(" 公司 ".into()),
    )
    .unwrap();
    assert_eq!(relay.url, "https://relay.example.com/");
    assert_eq!(relay.token.as_deref(), Some("tok"));
    assert_eq!(relay.fingerprint, Some([0xab; 32]));
    assert_eq!(relay.name.as_deref(), Some("公司"));
    assert_eq!(relay.host(), "relay.example.com");
    assert_eq!(
        Relay::new("https://relay.example.com:8443/path?x=1", None, None, None)
            .unwrap()
            .url,
        "https://relay.example.com:8443/"
    );
    assert!(Relay::new("http://relay.example.com", None, None, None).is_err());
    assert!(Relay::new("", None, None, None).is_err());
    assert_eq!(
        Relay::new("relay.example.com", None, Some("12ab"), None),
        Err(relays::RelayError::BadFingerprint)
    );
    // 空令牌、空名字当没有
    let bare = Relay::new(
        "relay.example.com",
        Some(" ".into()),
        Some(""),
        Some("".into()),
    )
    .unwrap();
    assert_eq!(
        (bare.token, bare.fingerprint, bare.name),
        (None, None, None)
    );
}

#[test]
fn links_carry_relays_and_callbacks_and_do_not_mix_up() {
    let relay = Relay::new(
        "relay.example.com",
        Some("a-long-shared-token-0123456789".into()),
        Some(&"cd".repeat(32)),
        Some("公司的中继".into()),
    )
    .unwrap();

    // 邀请链接带中继：令牌、指纹都在
    let mut invite = sample_invite();
    invite.relay = Some(relay.clone());
    let link = invite.to_link();
    assert!(link.len() < 500, "链接太长：{}", link.len());
    assert_eq!(Invite::parse(&link).unwrap(), invite);

    // P10.1 发出去的 v1 链接照样认（没有中继）
    let plain = sample_invite();
    let mut v1 = vec![1u8];
    v1.extend(protocol::encode(&(
        plain.host,
        plain.addrs.clone(),
        plain.session,
        plain.secret,
        plain.permission,
    )));
    let v1 = ticket::encode_link("odea://join/", &v1);
    assert_eq!(Invite::parse(&v1).unwrap(), plain);

    // 回连链接
    let callback = Callback {
        guest: [8; 32],
        addrs: vec!["[2408:8207::5]:4000".parse().unwrap()],
        session: [6; 16],
        relay: Some(relay.clone()),
    };
    let back = callback.to_link();
    assert!(back.starts_with("odea://back/"));
    assert_eq!(Callback::parse(&back).unwrap(), callback);
    assert_eq!(Callback::parse(&format!(" <{back}> ")).unwrap(), callback);

    // 中继码
    let code = relay.to_code();
    assert!(code.starts_with("odea://relay/"));
    assert_eq!(Relay::parse_code(&code).unwrap(), relay);
    assert_eq!(
        Relay::parse_code(
            &code
                .to_uppercase()
                .replace("ODEA://RELAY/", "odea://relay/")
        )
        .unwrap(),
        relay
    );

    // 粘错了地方：不硬解
    assert_eq!(Callback::parse(&link), Err(LinkError::Malformed));
    assert_eq!(Invite::parse(&back), Err(LinkError::Malformed));
    assert_eq!(Relay::parse_code(&link), Err(LinkError::Malformed));
    assert_eq!(Invite::parse(&code), Err(LinkError::Malformed));
}

/* ---------------- 中继（进程里起一台真的 iroh-relay） ---------------- */

/// 只放行拿着这个令牌的（官方程序的 access.shared_token 也是这么判的）
#[derive(Debug)]
struct TokenGate(&'static str);

impl iroh_relay::server::AccessControl for TokenGate {
    async fn on_connect(
        &self,
        request: &iroh_relay::server::ClientRequest,
    ) -> iroh_relay::server::Access {
        if request.auth_token().as_deref() == Some(self.0) {
            iroh_relay::server::Access::Allow
        } else {
            iroh_relay::server::Access::Deny {
                reason: Some("token rejected".into()),
            }
        }
    }
}

/// 起一台中继：自签名证书，返回地址和证书指纹（十六进制）。团队端点的测试也用
pub(crate) async fn start_relay(token: &'static str) -> (iroh_relay::server::Server, String, String) {
    use iroh_relay::server::{CertConfig, RelayConfig, Server, ServerConfig, TlsConfig};
    let (certs, server_config) = iroh_relay::server::testing::self_signed_tls_certs_and_config();
    let mut relay = RelayConfig::new((Ipv4Addr::LOCALHOST, 0));
    relay.tls = Some(TlsConfig::new(
        (Ipv4Addr::LOCALHOST, 0),
        CertConfig::Manual { server_config },
    ));
    relay.access = std::sync::Arc::new(TokenGate(token));
    let mut config = ServerConfig::default();
    config.relay = Some(relay);
    let server = Server::spawn(config).await.expect("中继起不来");
    let url = format!("https://{}", server.https_addr().expect("有 https 地址"));
    let pin = data_encoding::HEXLOWER.encode(&relays::fingerprint_of(certs[0].as_ref()));
    (server, url, pin)
}

pub(crate) fn relay_at(url: &str, token: Option<&str>, pin: &str) -> Relay {
    Relay::new(
        url,
        token.map(Into::into),
        Some(pin),
        Some("测试中继".into()),
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn relay_check_reports_connected_denied_and_wrong_certificates() {
    let (_server, url, pin) = start_relay("secret").await;

    let ok = relays::check(&relay_at(&url, Some("secret"), &pin), WAIT).await;
    assert!(ok.connected, "{ok:?}");
    assert!(ok.latency_ms.is_some(), "{ok:?}");
    assert_eq!(ok.denied, None);

    let denied = relays::check(&relay_at(&url, Some("wrong"), &pin), WAIT).await;
    assert!(!denied.connected, "{denied:?}");
    assert!(denied.denied.is_some(), "令牌不对要说出来：{denied:?}");

    // 证书和指纹对不上：连不上，不会退回去当普通证书校验
    let forged = relays::check(
        &relay_at(&url, Some("secret"), &"00".repeat(32)),
        Duration::from_secs(4),
    )
    .await;
    assert!(!forged.connected, "{forged:?}");
    assert!(forged.error.is_some(), "{forged:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guests_reach_hosts_through_the_relay() {
    let (_server, url, pin) = start_relay("secret").await;
    let relay = relay_at(&url, Some("secret"), &pin);
    let (events, mut host_events) = unbounded_channel();
    let host = Host::start(
        HostOptions {
            secret_key: SecretKey::generate(),
            name: "林夕".into(),
            title: "经中继".into(),
            permission: Permission::Edit,
            mdns: false,
            relays: vec![relay.clone()],
            portmap: false,
            firewall: false,
            note: String::new(),
            scope: protocol::Scope::doc(DOC, "经中继"),
            record: None,
            resume: None,
            trusted: Default::default(),
        },
        events,
    )
    .await
    .expect("主持人起不来");
    host.allow_docs(&[DOC]);

    // 分享前自检：中继连上了，链接里带着它（令牌、指纹一起）
    let link = expect(&mut host_events, "自检：中继连上", |event| match event {
        Event::Control(Control::Reach { reach, link }) => reach
            .relays
            .iter()
            .any(|relay| matches!(relay.state, reach::RelayState::Connected { .. }))
            .then(|| link.clone())
            .flatten(),
        _ => None,
    })
    .await;
    let from_link = Invite::parse(&link).unwrap();
    assert_eq!(from_link.relay.as_ref(), Some(&relay));

    // 访客只知道中继（链接里的直连地址都去掉）：照样进来、照样收发
    let mut invite = host.invite();
    invite.addrs.clear();
    let (guest, mut guest_events) = join("隔着中继", invite).await;
    let request = expect(&mut host_events, "加入请求", |event| match event {
        Event::Control(Control::JoinRequest { request, .. }) => Some(*request),
        _ => None,
    })
    .await;
    host.answer(request, Decision::Allow(Permission::Edit));
    expect(&mut guest_events, "进来了", |event| {
        matches!(status_of(event), Some(Status::Connected { .. })).then_some(())
    })
    .await;
    // 主持人那边登记好（文档流接上）才发得到
    expect(&mut host_events, "主持人的 SyncStart", |event| {
        matches!(event, Event::SyncStart { with: 1, .. }).then_some(())
    })
    .await;
    expect(&mut guest_events, "走哪条路", |event| {
        matches!(event, Event::Control(Control::Route { .. })).then_some(())
    })
    .await;
    host.send_update(DOC, b"via-relay".to_vec());
    expect(&mut guest_events, "经中继的更新", |event| {
        matches!(event, Event::Update { from: 0, bytes, .. } if bytes == b"via-relay").then_some(())
    })
    .await;
    guest.send_update(DOC, b"back-via-relay".to_vec());
    expect(&mut host_events, "访客经中继的更新", |event| {
        matches!(event, Event::Update { from: 1, bytes, .. } if bytes == b"back-via-relay")
            .then_some(())
    })
    .await;
    guest.leave().await;
    host.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wrong_relay_tokens_are_named_in_the_diagnosis() {
    let (_server, url, pin) = start_relay("secret").await;
    let (host, _host_events) = start_host("t").await;
    let mut invite = host.invite();
    // 主持人连不进来，中继又不收这个令牌
    invite.addrs = vec![SocketAddr::from((Ipv4Addr::new(192, 0, 2, 1), 9))];
    invite.relay = Some(relay_at(&url, Some("stale-token"), &pin));
    let (guest, mut events) = join("拿着旧令牌", invite).await;
    // 第一次结论可能出在中继回话之前（3 秒），之后每次重试再看一遍：最多等到第二轮
    let cause = expect_within(
        &mut events,
        "说出令牌不对",
        Duration::from_secs(30),
        |event| match status_of(event) {
            Some(Status::Unreachable { diagnosis })
                if matches!(diagnosis.cause, diagnose::Cause::RelayDenied { .. }) =>
            {
                Some(diagnosis.cause)
            }
            _ => None,
        },
    )
    .await;
    assert!(matches!(cause, diagnose::Cause::RelayDenied { .. }));
    guest.leave().await;
    host.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn callback_links_let_the_host_dial_the_guest() {
    let (host, mut host_events) = start_host("回连").await;
    // 主持人连不进来（链接里的地址没人听）
    let mut invite = host.invite();
    invite.addrs = vec![SocketAddr::from((Ipv4Addr::LOCALHOST, 9))];
    let (guest, mut events) = join("能被连的人", invite).await;
    expect(&mut events, "连不上", |event| {
        matches!(status_of(event), Some(Status::Unreachable { .. })).then_some(())
    })
    .await;

    // 访客生成回连链接；单测里只走本机回环
    let made = guest.callbacks().make().await;
    assert!(!made.reach.checking);
    let mut callback = Callback::parse(&made.link).unwrap();
    assert_eq!(callback.session, host.invite().session);
    callback.addrs = guest
        .bound_sockets()
        .into_iter()
        .filter(|addr| addr.is_ipv4())
        .map(|addr| SocketAddr::from((Ipv4Addr::LOCALHOST, addr.port())))
        .collect();

    // 别的会话的回连链接：直说，不拨
    let mut stale = callback.clone();
    stale.session = [9; 16];
    assert!(host.dial_back(stale).is_err());

    host.dial_back(callback.clone()).unwrap();
    // 同一个链接点两次不拨两遍
    host.dial_back(callback).unwrap();
    expect(&mut host_events, "拨通了", |event| {
        matches!(event, Event::Control(Control::DialBack { ok: true, .. })).then_some(())
    })
    .await;
    // 拨过去以后照样要主持人确认
    let request = expect(&mut host_events, "加入请求", |event| match event {
        Event::Control(Control::JoinRequest {
            request,
            invited,
            name,
            ..
        }) => {
            assert!(*invited);
            assert_eq!(name, "能被连的人");
            Some(*request)
        }
        _ => None,
    })
    .await;
    host.answer(request, Decision::Allow(Permission::Edit));
    expect(&mut events, "进来了", |event| {
        matches!(status_of(event), Some(Status::Connected { .. })).then_some(())
    })
    .await;
    expect(&mut host_events, "主持人的 SyncStart", |event| {
        matches!(event, Event::SyncStart { with: 1, .. }).then_some(())
    })
    .await;
    host.send_update(DOC, b"dialed-back".to_vec());
    expect(&mut events, "回连上以后的更新", |event| {
        matches!(event, Event::Update { from: 0, bytes, .. } if bytes == b"dialed-back").then_some(())
    })
    .await;
    expect_none(&mut host_events, "只有一个加入请求", |event| {
        matches!(event, Event::Control(Control::JoinRequest { .. }))
    })
    .await;

    // 访客离开：主持人不再往回拨
    guest.leave().await;
    expect(&mut host_events, "离开后的成员表", |event| {
        members_of(event)
            .filter(|members| members.len() == 1)
            .map(|_| ())
    })
    .await;
    host.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn hosts_report_reach_with_a_fresh_link() {
    let (host, mut host_events) = start_host("t").await;
    // 没开端口映射、没配中继：读完网卡（Windows 上两秒多）就有结论
    let (reach, link) = expect(&mut host_events, "自检", |event| match event {
        Event::Control(Control::Reach { reach, link }) if !reach.checking => {
            Some((reach.clone(), link.clone()))
        }
        _ => None,
    })
    .await;
    assert!(reach.relays.is_empty());
    assert_eq!(reach.portmap, reach::Portmap::Unavailable);
    let link = Invite::parse(&link.expect("主持人的自检带着链接")).unwrap();
    assert_eq!(link.session, host.invite().session);
    assert_eq!(link.relay, None);
    host.stop().await;
}

/* ---------------- P10.1 的遗留：落盘、附近、附件、慢的访客、防火墙 ---------------- */

fn host_options(title: &str) -> HostOptions {
    HostOptions {
        secret_key: SecretKey::generate(),
        name: "林夕".into(),
        title: title.into(),
        permission: Permission::Edit,
        mdns: false,
        relays: Vec::new(),
        portmap: false,
        firewall: false,
        note: DOC.into(),
        scope: protocol::Scope::doc(DOC, title),
        record: None,
        resume: None,
        trusted: Default::default(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_crashed_host_comes_back_and_guests_reconnect_without_asking() {
    let dir = tempfile::tempdir().unwrap();
    let key = SecretKey::generate();
    let (events, mut host_events) = unbounded_channel();
    let host = Host::start(
        HostOptions {
            secret_key: key.clone(),
            record: Some(dir.path().to_path_buf()),
            ..host_options("周会")
        },
        events,
    )
    .await
    .unwrap();
    host.allow_docs(&[DOC]);
    let (guest, mut guest_events, member) =
        admitted(&host, &mut host_events, "Alex", Permission::Read).await;
    // 前端每隔几秒交来的 文档 状态（这里随便几个字节）
    record::save_state(dir.path(), record::Role::Host, DOC, b"y-state").unwrap();
    let left = record::host_left(dir.path()).expect("落盘的记录");
    assert_eq!(left.note, "note-1");
    assert_eq!(left.title, "周会");
    assert_eq!(left.approved.len(), 1);
    assert_eq!(
        (left.approved[0].member, left.approved[0].permission),
        (member, Permission::Read)
    );
    let old_session = host.invite().session;

    // 主持人那台崩了：谁都没告诉，记录留着
    host.crash().await;
    expect(&mut guest_events, "重新连接中", |event| {
        matches!(status_of(event), Some(Status::Reconnecting)).then_some(())
    })
    .await;
    assert!(record::host_left(dir.path()).is_some());

    // 重启以后照记录起来：同一个会话 id、邀请密钥、端口
    let (events, mut host_events) = unbounded_channel();
    let host = Host::start(
        HostOptions {
            secret_key: key,
            record: Some(dir.path().to_path_buf()),
            resume: Some(left),
            ..host_options("周会")
        },
        events,
    )
    .await
    .unwrap();
    host.allow_docs(&[DOC]);
    assert_eq!(host.invite().session, old_session);
    // 访客自己接上：不再问，还是原来的成员号和权限
    let (again, permission) = expect(&mut guest_events, "接上了", |event| {
        match status_of(event) {
            Some(Status::Connected {
                member, permission, ..
            }) => Some((member, permission)),
            _ => None,
        }
    })
    .await;
    assert_eq!((again, permission), (member, Permission::Read));
    expect(&mut host_events, "主持人的 SyncStart", |event| {
        matches!(event, Event::SyncStart { with, .. } if *with == member).then_some(())
    })
    .await;
    expect_none(&mut host_events, "接上不该再问", |event| {
        matches!(event, Event::Control(Control::JoinRequest { .. }))
    })
    .await;
    host.send_update(DOC, b"after-crash".to_vec());
    expect(&mut guest_events, "重启后的更新", |event| {
        matches!(event, Event::Update { from: 0, bytes, .. } if bytes == b"after-crash").then_some(())
    })
    .await;

    // 正常停止：记录删掉，重启后不再问
    host.stop().await;
    assert!(record::host_left(dir.path()).is_none());
    assert!(!dir.path().join(record::HOST_FILE).exists());
    assert!(record::saved_docs(dir.path(), record::Role::Host).is_empty());
    drop(guest);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn nearby_guests_ask_without_a_link() {
    let (host, mut host_events) = start_host("t").await;
    // 「附近」点进来的：只知道公钥和地址
    let mut invite = loopback(&host, host.invite());
    invite.session = [0; 16];
    invite.secret = [0; 32];
    let (events_tx, mut events) = unbounded_channel();
    let _guest = Guest::join(
        GuestOptions {
            secret_key: SecretKey::generate(),
            name: "同一个 Wi-Fi".into(),
            invite,
            mdns: false,
            use_host_relay: true,
            relays: Vec::new(),
            portmap: false,
            nearby: true,
        },
        events_tx,
    )
    .await
    .unwrap();
    let request = expect(&mut host_events, "附近的加入请求", |event| match event {
        Event::Control(Control::JoinRequest {
            request, invited, ..
        }) => {
            // 没拿着链接：界面上说「在同一个网络里，想加入」
            assert!(!invited);
            Some(*request)
        }
        _ => None,
    })
    .await;
    host.answer(request, Decision::Allow(Permission::Edit));
    let title = expect(&mut events, "进来了", |event| match status_of(event) {
        Some(Status::Connected { title, .. }) => Some(title),
        _ => None,
    })
    .await;
    // 标题在允许之后才给（广播里不带）
    assert_eq!(title, "t");
    host.stop().await;
}

/// 真的 mDNS：主持人广播，「附近」列表看到他，点一下加入。要组播，沙箱、CI 里不一定通，平时不跑
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore]
async fn nearby_list_finds_a_sharing_host_over_mdns() {
    let (events, mut host_events) = unbounded_channel();
    let host = Host::start(
        HostOptions {
            mdns: true,
            ..host_options("t")
        },
        events,
    )
    .await
    .unwrap();
    host.allow_docs(&[DOC]);
    let (scan_tx, mut scan) = unbounded_channel();
    let nearby = nearby::Nearby::start(scan_tx).await.expect("mDNS 起不来");
    let id = host.id();
    expect_within(
        &mut scan,
        "列表里出现主持人",
        Duration::from_secs(20),
        |event| match event {
            Event::Control(Control::Nearby { hosts }) => hosts
                .iter()
                .any(|found| found.id == id && found.name == "林夕")
                .then_some(()),
            _ => None,
        },
    )
    .await;
    let invite = nearby.invite(&id).expect("列表里的地址");
    nearby.stop().await;
    let (events_tx, _events) = unbounded_channel();
    let _guest = Guest::join(
        GuestOptions {
            secret_key: SecretKey::generate(),
            name: "邻座".into(),
            invite,
            mdns: true,
            use_host_relay: true,
            relays: Vec::new(),
            portmap: false,
            nearby: true,
        },
        events_tx,
    )
    .await
    .unwrap();
    expect(&mut host_events, "加入请求", |event| {
        matches!(
            event,
            Event::Control(Control::JoinRequest { invited: false, .. })
        )
        .then_some(())
    })
    .await;
    host.stop().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn guests_fetch_referenced_attachments_and_hand_over_pasted_ones() {
    let (host, mut host_events) = start_host("t").await;
    let (guest, _guest_events, _member) =
        admitted(&host, &mut host_events, "Alex", Permission::Edit).await;

    // 要一个文件：主持人那边变成事件，命令层回字节
    let files = guest.attachments();
    let fetch = tokio::spawn(async move { files.fetch(DOC, "../附件/a.png").await });
    let request = expect(&mut host_events, "要附件", |event| match event {
        Event::AttachGet { request, path, .. } => {
            assert_eq!(path, "../附件/a.png");
            Some(*request)
        }
        _ => None,
    })
    .await;
    // 大一点的文件：比控制流、文档流的单帧上限还大也照样传
    let big = vec![9u8; (protocol::MAX_FRAME) + 1024];
    assert!(host.answer_attachment(request, Ok(AttachReply::Data(big.clone()))));
    assert_eq!(fetch.await.unwrap().unwrap(), big);

    // 给不了：说为什么
    let files = guest.attachments();
    let fetch = tokio::spawn(async move { files.fetch(DOC, "C:/secret.png").await });
    let request = expect(&mut host_events, "要附件", |event| match event {
        Event::AttachGet { request, .. } => Some(*request),
        _ => None,
    })
    .await;
    host.answer_attachment(request, Err("这个文件不在这篇正文里".into()));
    assert_eq!(
        fetch.await.unwrap(),
        Err("这个文件不在这篇正文里".to_string())
    );

    // 粘贴的文件交给主持人存
    let files = guest.attachments();
    let put = tokio::spawn(async move { files.put(DOC, "截图.png", b"pasted".to_vec()).await });
    let request = expect(&mut host_events, "存附件", |event| match event {
        Event::AttachPut {
            request,
            name,
            bytes,
            ..
        } => {
            assert_eq!(
                (name.as_str(), bytes.as_slice()),
                ("截图.png", &b"pasted"[..])
            );
            Some(*request)
        }
        _ => None,
    })
    .await;
    host.answer_attachment(request, Ok(AttachReply::Link("../附件/截图.png".into())));
    assert_eq!(put.await.unwrap(), Ok("../附件/截图.png".to_string()));

    // 太大的不传
    let too_big = vec![0u8; protocol::MAX_ATTACHMENT + 1];
    assert!(guest.attachments().put(DOC, "big.bin", too_big).await.is_err());

    // 只读的人传不了：主持人那边连事件都没有
    let (reader, _reader_events, _) =
        admitted(&host, &mut host_events, "佐藤", Permission::Read).await;
    let refused = reader.attachments().put(DOC, "x.png", b"x".to_vec()).await;
    assert!(refused.unwrap_err().contains("只读"));
    expect_none(&mut host_events, "只读的人的附件", |event| {
        matches!(event, Event::AttachPut { .. })
    })
    .await;
    host.stop().await;
}

#[tokio::test]
async fn slow_guests_get_one_resync_instead_of_a_long_queue() {
    let queue = queue::DocQueue::default();
    // 加入时的快照很大也不算积压
    assert_eq!(
        queue.push(kind::SYNC2, vec![0; 4 << 20]),
        queue::Pushed::Queued
    );
    for _ in 0..queue::LAG_FRAMES - 1 {
        assert_eq!(queue.push(kind::UPDATE, vec![1; 20]), queue::Pushed::Queued);
    }
    // 再来一个：判定积压，排着的更新（连那份快照）丢掉，换成一个 Resync；状态向量这种留着
    assert_eq!(queue.push(kind::SYNC1, vec![7]), queue::Pushed::Collapsed);
    let (kinds, update_bytes, pending) = queue.snapshot();
    assert_eq!(kinds, vec![kind::SYNC1, kind::RESYNC]);
    assert_eq!(update_bytes, 0);
    assert!(pending);
    // 等他的 Sync1 期间：更新不用排了
    assert_eq!(queue.push(kind::UPDATE, vec![1]), queue::Pushed::Skipped);
    assert_eq!(queue.push(kind::SYNC2, vec![1]), queue::Pushed::Skipped);
    // 他发来了 Sync1：回他的 Sync2 照常排
    queue.resynced();
    assert_eq!(queue.push(kind::SYNC2, vec![2; 10]), queue::Pushed::Queued);
    assert_eq!(queue.pop().await, Some((kind::SYNC1, vec![7])));
    assert_eq!(queue.pop().await, Some((kind::RESYNC, vec![])));
    assert_eq!(queue.pop().await, Some((kind::SYNC2, vec![2; 10])));
    // 字节数也算：一大段粘贴拆出来的更新
    let queue = queue::DocQueue::default();
    for _ in 0..3 {
        queue.push(kind::UPDATE, vec![0; queue::LAG_BYTES / 4]);
    }
    assert_eq!(
        queue.push(kind::UPDATE, vec![0; queue::LAG_BYTES / 2]),
        queue::Pushed::Collapsed
    );
    // 关掉：排着的取完就是 None，新的不收
    queue.close();
    assert_eq!(queue.push(kind::UPDATE, vec![1]), queue::Pushed::Closed);
    assert_eq!(queue.pop().await, Some((kind::RESYNC, vec![])));
    assert_eq!(queue.pop().await, None);
}

#[test]
fn firewall_verdicts_follow_the_current_network() {
    use firewall::{evaluate, Firewall, Rule, PRIVATE, PUBLIC};
    let on = |_| true;
    let allow_private = Rule {
        allow: true,
        profiles: PRIVATE,
        udp: true,
    };
    // Windows 弹窗里只勾了「专用」：给「公用」建了一条阻止规则
    let block_public = Rule {
        allow: false,
        profiles: PUBLIC,
        udp: true,
    };
    let rules = [allow_private.clone(), block_public];
    assert_eq!(
        evaluate(PRIVATE, on, &rules),
        Firewall::Allowed { public: false }
    );
    assert_eq!(
        evaluate(PUBLIC, on, &rules),
        Firewall::Blocked { public: true }
    );
    // 公用网络上防火墙关着：放行
    assert_eq!(
        evaluate(PUBLIC, |profile| profile != PUBLIC, &rules),
        Firewall::Allowed { public: true }
    );
    // 还没问过
    assert_eq!(
        evaluate(PUBLIC, on, &[]),
        Firewall::NotAsked { public: true }
    );
    // 只管 TCP 的规则不算
    let tcp_only = Rule {
        allow: true,
        profiles: PUBLIC,
        udp: false,
    };
    assert_eq!(
        evaluate(PUBLIC, on, &[tcp_only]),
        Firewall::NotAsked { public: true }
    );
    // 阻止优先
    let allow_all = Rule {
        allow: true,
        profiles: PRIVATE | PUBLIC,
        udp: true,
    };
    let block_all = Rule {
        allow: false,
        profiles: PRIVATE | PUBLIC,
        udp: true,
    };
    assert_eq!(
        evaluate(PRIVATE, on, &[allow_all, block_all]),
        Firewall::Blocked { public: false }
    );
    assert_eq!(evaluate(0, on, &[allow_private]), Firewall::Unknown);
    // 真的读一次本机（Windows 上走 COM，别的系统是 Unknown）：不能崩
    let started = std::time::Instant::now();
    eprintln!(
        "本机的防火墙：{:?}（{:?}）",
        firewall::check(),
        started.elapsed()
    );
}

#[test]
fn records_round_trip_and_only_count_with_their_state() {
    let dir = tempfile::tempdir().unwrap();
    let mut host = record::HostRecord::new("n".into(), "标题".into(), Permission::Edit);
    host.session = data_encoding::HEXLOWER.encode(&[1u8; 16]);
    host.secret = data_encoding::HEXLOWER.encode(&[2u8; 32]);
    record::save_json(dir.path(), record::HOST_FILE, &host).unwrap();
    // 没有 文档 的状态：不算（接不上）
    assert!(record::host_left(dir.path()).is_none());
    record::save_state(dir.path(), record::Role::Host, DOC, b"state").unwrap();
    let back = record::host_left(dir.path()).unwrap();
    assert_eq!(back, host);
    assert_eq!(back.session_bytes(), Some([1u8; 16]));
    assert_eq!(
        record::load_state(dir.path(), record::Role::Host, DOC).as_deref(),
        Some(&b"state"[..])
    );
    let guest = record::GuestRecord::new("odea://join/x".into(), false, true);
    record::save_json(dir.path(), record::GUEST_FILE, &guest).unwrap();
    record::save_state(dir.path(), record::Role::Guest, DOC, b"g").unwrap();
    assert_eq!(record::guest_left(dir.path()), Some(guest));
    record::remove(dir.path(), record::Role::Host);
    assert!(record::host_left(dir.path()).is_none());
    assert!(record::guest_left(dir.path()).is_some());
}

/// 拿着一把定好的设备密钥加入（记住的人按公钥认）
async fn join_as(key: &SecretKey, name: &str, invite: Invite) -> (Guest, UnboundedReceiver<Event>) {
    let (events, rx) = unbounded_channel();
    let guest = Guest::join(
        GuestOptions {
            secret_key: key.clone(),
            name: name.into(),
            invite,
            mdns: false,
            use_host_relay: true,
            relays: Vec::new(),
            portmap: false,
            nearby: false,
        },
        events,
    )
    .await
    .expect("访客起不来");
    (guest, rx)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remembered_people_come_in_without_asking_until_forgotten() {
    let key = SecretKey::generate();
    let id = *key.public().as_bytes();
    let (events, mut host_events) = unbounded_channel();
    let host = Host::start(
        HostOptions {
            trusted: [(id, Permission::Read)].into_iter().collect(),
            ..host_options("周会")
        },
        events,
    )
    .await
    .expect("主持人起不来");
    host.allow_docs(&[DOC]);

    // 记住的人：不问，按记住的权限进来
    let (guest, mut guest_events) = join_as(&key, "Alex", loopback(&host, host.invite())).await;
    let permission = expect(&mut guest_events, "直接进来", |event| {
        match status_of(event) {
            Some(Status::Connected { permission, .. }) => Some(permission),
            _ => None,
        }
    })
    .await;
    assert_eq!(permission, Permission::Read);
    expect_none(&mut host_events, "记住的人不该问", |event| {
        matches!(event, Event::Control(Control::JoinRequest { .. }))
    })
    .await;
    assert_eq!(host.members().len(), 2);
    guest.leave().await;

    // 记住的是人，不是链接：链接换过，旧链接照样拒
    let old = loopback(&host, host.invite());
    let fresh = loopback(&host, host.reset_invite());
    let (_stale, mut stale_events) = join_as(&key, "Alex", old).await;
    let reason = expect(&mut stale_events, "旧链接", |event| {
        match status_of(event) {
            Some(Status::Ended { reason }) => Some(reason),
            _ => None,
        }
    })
    .await;
    assert_eq!(
        reason,
        EndReason::Rejected {
            reason: RejectReason::BadInvite
        }
    );

    // 会话中途忘掉：「允许过、重连不问」也一起清掉，离开再回来要问
    host.forget(&id);
    let (_again, mut again_events) = join_as(&key, "Alex", fresh.clone()).await;
    let request = expect(&mut host_events, "忘掉以后再来要问", |event| match event {
        Event::Control(Control::JoinRequest { request, .. }) => Some(*request),
        _ => None,
    })
    .await;
    assert!(host.answer(request, Decision::Allow(Permission::Edit)));
    let member = expect(
        &mut again_events,
        "允许了又进来",
        |event| match status_of(event) {
            Some(Status::Connected { member, .. }) => Some(member),
            _ => None,
        },
    )
    .await;

    // 移出：记住过的也忘掉（返回被移出的公钥，命令层据此从 config.json 里删），再来就拒
    host.trust(id, Permission::Edit);
    assert_eq!(host.kick(member), Some(id));
    let (_kicked, mut kicked_events) = join_as(&key, "Alex", fresh).await;
    let reason = expect(
        &mut kicked_events,
        "移出以后",
        |event| match status_of(event) {
            Some(Status::Ended { reason }) => Some(reason),
            _ => None,
        },
    )
    .await;
    assert_eq!(
        reason,
        EndReason::Rejected {
            reason: RejectReason::Kicked
        }
    );
    host.stop().await;

    // 忘掉：下一次会话里照样问（这次会话里允许过的人重连不问，那是另一回事）
    let (events, mut host_events) = unbounded_channel();
    let host = Host::start(
        HostOptions {
            trusted: [(id, Permission::Edit)].into_iter().collect(),
            ..host_options("周会")
        },
        events,
    )
    .await
    .expect("主持人起不来");
    host.allow_docs(&[DOC]);
    host.forget(&id);
    let (_asked, _asked_events) = join_as(&key, "Alex", loopback(&host, host.invite())).await;
    expect(&mut host_events, "忘掉以后要问", |event| {
        matches!(event, Event::Control(Control::JoinRequest { .. })).then_some(())
    })
    .await;
    host.stop().await;
}

#[test]
fn cached_attachment_keeps_the_written_name() {
    use super::record::cached_name;
    assert_eq!(cached_name("../附件/截图.png"), "截图.png");
    assert_eq!(cached_name("附件/%E6%88%AA%E5%9B%BE%201.PNG"), "截图-1.png");
    assert_eq!(cached_name("..\\附件\\a b.jpg"), "a-b.jpg");
    assert_eq!(cached_name("附件/.png"), "png");
    assert_eq!(cached_name("附件/!!!.png"), "图片.png");
    assert_eq!(cached_name("附件/没有扩展名"), "没有扩展名");
    assert_eq!(cached_name("附件/100%.gif"), "100.gif");
    assert_eq!(cached_name("附件/x.tar.gz"), "x.tar.gz");
}

/// 手工拨主持人、发一个指定版本的 Hello，读回主持人的回话（Reject 的原因）
async fn hello_with_version(host: &Host, version: u16) -> RejectReason {
    let invite = loopback(host, host.invite());
    let bound = endpoint::bind(SecretKey::generate(), None, false, &[], &[])
        .await
        .expect("起不来端点");
    let addr = endpoint::dial_addr(&invite.host, &invite.addrs, None).unwrap();
    let conn = tokio::time::timeout(WAIT, bound.endpoint.connect(addr, protocol::ALPN))
        .await
        .expect("拨号超时")
        .expect("拨不通");
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    let hello = protocol::Hello {
        version,
        features: protocol::FEATURES.iter().map(|f| f.to_string()).collect(),
        session: invite.session,
        proof: None,
        name: "旧版的人".into(),
    };
    protocol::write_frame(&mut send, kind::HELLO, &protocol::encode(&hello))
        .await
        .unwrap();
    let (frame, payload) = tokio::time::timeout(WAIT, protocol::read_frame(&mut recv))
        .await
        .expect("等回话超时")
        .unwrap()
        .expect("主持人没回话");
    assert_eq!(frame, kind::REJECT);
    bound.endpoint.close().await;
    protocol::decode::<protocol::Reject>(&payload)
        .unwrap()
        .reason
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn version_mismatch_says_whose_odea_is_older() {
    let (host, mut host_events) = start_host("周会").await;
    // 对方的旧：主持人回自己的版本，主持人这边也知道一声（不打扰成加入请求）
    let reason = hello_with_version(&host, protocol::PROTOCOL_VERSION - 1).await;
    assert_eq!(
        reason,
        RejectReason::Version {
            theirs: protocol::PROTOCOL_VERSION
        }
    );
    let older = expect(&mut host_events, "版本不对的知会", |event| match event {
        Event::Control(Control::JoinOutdated { name, guest_older }) if name == "旧版的人" => {
            Some(*guest_older)
        }
        _ => None,
    })
    .await;
    assert!(older);
    // 对方的新：主持人该升级
    hello_with_version(&host, protocol::PROTOCOL_VERSION + 1).await;
    let older = expect(&mut host_events, "版本不对的知会", |event| match event {
        Event::Control(Control::JoinOutdated { guest_older, .. }) => Some(*guest_older),
        _ => None,
    })
    .await;
    assert!(!older);
    expect_none(
        &mut host_events,
        "版本不对的不该问主持人",
        |event| matches!(event, Event::Control(Control::JoinRequest { .. })),
    )
    .await;
    host.stop().await;
}

/// 一台「以后的」中继：TLS 和 /ping 照常，WebSocket 升级按 iroh-relay 的样子回 400，说它只支持 v3
/// （iroh 升大版本以后，用户的中继比 Odea 新就是这样）。同步的线程，测试结束跟着进程走
fn start_future_relay() -> (String, String) {
    use std::io::{Read, Write};
    let (certs, config) = iroh_relay::server::testing::self_signed_tls_certs_and_config();
    let config = std::sync::Arc::new(config);
    let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let url = format!("https://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let config = config.clone();
            std::thread::spawn(move || {
                let Ok(conn) = rustls::ServerConnection::new(config) else {
                    return;
                };
                let mut tls = rustls::StreamOwned::new(conn, stream);
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match tls.read(&mut buf) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let request = String::from_utf8_lossy(&request).into_owned();
                // 网络报告的探测（/ping）照常回 200：以后的中继也还在线，只是升级那一步不认
                if request.starts_with("GET /ping") {
                    let _ = tls.write_all(
                        b"HTTP/1.1 200 OK
content-length: 0
connection: close

",
                    );
                    let _ = tls.flush();
                    tls.conn.send_close_notify();
                    let _ = tls.flush();
                    return;
                }
                let offered = request
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .starts_with("sec-websocket-protocol:")
                            .then(|| line.split_once(':').unwrap().1.trim().to_string())
                    })
                    .unwrap_or_default();
                let body = format!(
                    "invalid header value for sec-websocket-protocol: unsupported relay version: we support iroh-relay-v3 but you only provide {offered}"
                );
                let response = format!(
                    "HTTP/1.1 400 Bad Request\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = tls.write_all(response.as_bytes());
                let _ = tls.flush();
                tls.conn.send_close_notify();
                let _ = tls.flush();
            });
        }
    });
    let pin = data_encoding::HEXLOWER.encode(&relays::fingerprint_of(certs[0].as_ref()));
    (url, pin)
}

#[test]
fn upgrade_refusals_are_recognized() {
    assert!(relays::upgrade_refused(
        "Unexpected status during upgrade: 400 Bad Request"
    ));
    assert!(relays::upgrade_refused(
        "Failed to connect to relay server: unable to connect: expected HTTP 101 Switching Protocols, got status code 400"
    ));
    assert!(relays::upgrade_refused(
        "Server replied with invalid iroh-relay version header: iroh-relay-v3"
    ));
    assert!(!relays::upgrade_refused("timed out"));
    assert!(!relays::upgrade_refused(
        "Unexpected status during upgrade: 404 Not Found"
    ));
    assert!(relays::offered_versions().contains("iroh-relay-v1"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn relay_check_says_when_the_relay_version_does_not_match() {
    // 版本对不上的中继：测试直接说版本，带上它支持的那一版，不干等到时限
    let (url, pin) = start_future_relay();
    let started = std::time::Instant::now();
    let check = relays::check(&relay_at(&url, Some("secret"), &pin), WAIT).await;
    assert!(!check.connected, "{check:?}");
    assert_eq!(
        check.outdated.as_deref(),
        Some("iroh-relay-v3"),
        "{check:?}"
    );
    assert_eq!(check.error, None, "{check:?}");
    assert!(
        started.elapsed() < WAIT,
        "认出来就不用等满：{:?}",
        started.elapsed()
    );

    // 真的 iroh-relay：说一个它不认的版本，它的原话里有它支持的
    let (_server, url, pin) = start_relay("secret").await;
    let relay = relay_at(&url, None, &pin);
    let theirs =
        tokio::task::spawn_blocking(move || relays::probe_upgrade(&relay, "iroh-relay-v9"))
            .await
            .unwrap()
            .expect("问得出来");
    let theirs = theirs.expect("版本对不上");
    assert!(theirs.contains("iroh-relay-v2"), "{theirs}");
    // 正常的中继照样连得上，不会被认成版本不对
    let ok = relays::check(&relay_at(&url, Some("secret"), &pin), WAIT).await;
    assert!(ok.connected && ok.outdated.is_none(), "{ok:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn renaming_during_a_session_reaches_everyone() {
    let (host, mut host_events) = start_host("周会").await;
    let (guest, mut guest_events, member) =
        admitted(&host, &mut host_events, "Alex", Permission::Edit).await;

    // 访客改名：主持人的成员表换掉，再广播给访客
    guest.set_name("  阿历克斯 ");
    expect(&mut host_events, "主持人看到新名字", |event| match event {
        Event::Control(Control::Members { members })
            if members
                .iter()
                .any(|m| m.member == member && m.name == "阿历克斯") =>
        {
            Some(())
        }
        _ => None,
    })
    .await;
    expect(
        &mut guest_events,
        "访客那边的成员表也换了",
        |event| match event {
            Event::Control(Control::Members { members })
                if members
                    .iter()
                    .any(|m| m.member == member && m.name == "阿历克斯") =>
            {
                Some(())
            }
            _ => None,
        },
    )
    .await;

    // 主持人改名：成员表里的主持人换掉，访客那边跟着换
    host.set_name("林夕（主持）");
    assert!(host
        .members()
        .iter()
        .any(|m| m.host && m.name == "林夕（主持）"));
    expect(
        &mut guest_events,
        "访客看到主持人的新名字",
        |event| match event {
            Event::Control(Control::Members { members })
                if members.iter().any(|m| m.host && m.name == "林夕（主持）") =>
            {
                Some(())
            }
            _ => None,
        },
    )
    .await;
    // 空名字不算
    host.set_name("   ");
    assert!(host
        .members()
        .iter()
        .any(|m| m.host && m.name == "林夕（主持）"));
    host.stop().await;
}

#[test]
fn only_addresses_on_the_nic_count_as_a_public_ipv4() {
    use reach::{sort_addrs, Portmap, Reach};
    let addrs: Vec<SocketAddr> = [
        "192.168.1.2:5000",
        "125.84.158.172:61234",
        "58.33.10.2:5000",
    ]
    .iter()
    .map(|text| text.parse().unwrap())
    .collect();
    let empty = || Reach {
        checking: false,
        lan: Vec::new(),
        ipv6: Vec::new(),
        public_v4: Vec::new(),
        portmap: Portmap::Unavailable,
        relays: Vec::new(),
        firewall: firewall::Firewall::Unknown,
    };
    // 网卡上有 192.168.1.2 和 58.33.10.2；125.84.158.172 是中继看到的出口地址（NAT 外面）
    let local = ["192.168.1.2", "58.33.10.2"].map(|text| text.parse().unwrap());
    let mut reach = empty();
    sort_addrs(&addrs, &mut reach, Some(&local));
    assert_eq!(reach.lan, ["192.168.1.2"]);
    assert_eq!(reach.public_v4, ["58.33.10.2"]);
    // 网卡还没读出来：一个公网地址都不认
    let mut reach = empty();
    sort_addrs(&addrs, &mut reach, None);
    assert!(reach.public_v4.is_empty());
    assert_eq!(reach.lan, ["192.168.1.2"]);
}

/* ---------------- 访客之间转发（设计 §20.9） ---------------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_guest_forwards_for_someone_who_cannot_reach_the_host() {
    let (host, mut host_events) = start_host("转发").await;
    let (relay, mut relay_events, relay_member) =
        admitted(&host, &mut host_events, "B", Permission::Edit).await;

    // B 的转发链接：指着 B，会话 id、邀请密钥照旧；单测里只走本机回环
    let made = relay.callbacks().forward_link().await;
    let mut invite = Invite::parse(&made.link).unwrap();
    assert_eq!(invite.session, host.invite().session);
    assert_ne!(invite.host, host.invite().host);
    invite.addrs = relay
        .bound_sockets()
        .into_iter()
        .filter(|addr| addr.is_ipv4())
        .map(|addr| SocketAddr::from((Ipv4Addr::LOCALHOST, addr.port())))
        .collect();

    // C 只连得上 B：主持人那边是一个「经由 B」的加入请求（B 核过他的证明）
    let (far, mut far_events) = join("C", invite.clone()).await;
    let request = expect(&mut host_events, "经由 B 的加入请求", |event| match event {
        Event::Control(Control::JoinRequest {
            request,
            name,
            invited,
            via,
            ..
        }) if name == "C" => {
            assert!(*invited, "B 核过了证明");
            assert_eq!(via.as_deref(), Some("B"));
            Some(*request)
        }
        _ => None,
    })
    .await;
    assert!(host.answer(request, Decision::Allow(Permission::Edit)));
    let far_member = expect(&mut far_events, "C 进来了", |event| match status_of(event) {
        Some(Status::Connected { member, .. }) => Some(member),
        _ => None,
    })
    .await;
    assert!(far_member != relay_member && far_member != 0);
    expect(&mut far_events, "C 的 SyncStart", |event| {
        matches!(event, Event::SyncStart { with: 0, .. }).then_some(())
    })
    .await;
    expect(&mut host_events, "主持人和 C 的 SyncStart", |event| {
        matches!(event, Event::SyncStart { with, .. } if *with == far_member).then_some(())
    })
    .await;
    let via = host
        .members()
        .into_iter()
        .find(|member| member.member == far_member)
        .and_then(|member| member.via);
    assert_eq!(via, Some(relay_member), "成员表里记着经由谁");

    // 同步、两个方向的更新都经 B 走；B 自己也收到 C 的（主持人转给大家）
    far.send_sync(DOC, SyncKind::Vector, b"c-sv".to_vec());
    expect(&mut host_events, "C 的同步请求", |event| {
        matches!(event, Event::SyncRequest { from, vector, .. } if *from == far_member && vector == b"c-sv")
            .then_some(())
    })
    .await;
    host.send_sync(far_member, DOC, SyncKind::Reply, b"c-snapshot".to_vec());
    expect(&mut far_events, "C 收到快照", |event| {
        matches!(event, Event::Update { from: 0, bytes, .. } if bytes == b"c-snapshot").then_some(())
    })
    .await;
    far.send_update(DOC, b"from-c".to_vec());
    expect(&mut host_events, "主持人收到 C 的", |event| {
        matches!(event, Event::Update { from, bytes, .. } if *from == far_member && bytes == b"from-c")
            .then_some(())
    })
    .await;
    expect(&mut relay_events, "B 收到 C 的（主持人转给大家）", |event| {
        matches!(event, Event::Update { from: 0, bytes, .. } if bytes == b"from-c").then_some(())
    })
    .await;
    host.send_update(DOC, b"to-everyone".to_vec());
    expect(&mut far_events, "C 收到主持人的", |event| {
        matches!(event, Event::Update { from: 0, bytes, .. } if bytes == b"to-everyone").then_some(())
    })
    .await;

    // 光标：C 的经 B 到主持人（带着 C 的成员号），主持人的经 B 到 C
    let got = tokio::time::timeout(WAIT, async {
        loop {
            far.send_cursor(DOC, b"c-caret");
            tokio::time::sleep(Duration::from_millis(50)).await;
            while let Ok(event) = host_events.try_recv() {
                if matches!(&event, Event::Cursor { from, bytes, .. } if *from == far_member && bytes == b"c-caret") {
                    return;
                }
            }
        }
    })
    .await;
    assert!(got.is_ok(), "主持人收不到经 B 转的光标");
    let got = tokio::time::timeout(WAIT, async {
        loop {
            host.send_cursor(DOC, b"host-caret");
            tokio::time::sleep(Duration::from_millis(50)).await;
            while let Ok(event) = far_events.try_recv() {
                if matches!(&event, Event::Cursor { from: 0, bytes, .. } if bytes == b"host-caret") {
                    return;
                }
            }
        }
    })
    .await;
    assert!(got.is_ok(), "C 收不到经 B 转的主持人的光标");

    // 权限照主持人的：改成只读以后 C 的更新被丢
    host.set_permission(far_member, Permission::Read);
    expect(&mut far_events, "C 收到权限通知", |event| {
        matches!(event, Event::Control(Control::Permission { permission: Permission::Read }))
            .then_some(())
    })
    .await;
    far.send_update(DOC, b"c-read-only".to_vec());
    expect_none(&mut host_events, "只读的 C 的更新", |event| {
        matches!(event, Event::Update { bytes, .. } if bytes == b"c-read-only")
    })
    .await;

    // 证明不对的（链接被重置过）：B 当场拒，主持人那边没有请求
    let mut wrong = invite.clone();
    wrong.secret = [7; 32];
    let (_wrong, mut wrong_events) = join("拿错链接的人", wrong).await;
    let reason = expect(&mut wrong_events, "被拒", |event| match status_of(event) {
        Some(Status::Ended { reason }) => Some(reason),
        _ => None,
    })
    .await;
    assert_eq!(
        reason,
        EndReason::Rejected {
            reason: RejectReason::BadInvite
        }
    );
    expect_none(&mut host_events, "拿错链接的人的请求", |event| {
        matches!(event, Event::Control(Control::JoinRequest { name, .. }) if name == "拿错链接的人")
    })
    .await;

    // C 离开：主持人那边成员表少了他，B 还在
    far.leave().await;
    expect(&mut host_events, "C 走了以后的成员表", |event| {
        members_of(event)
            .filter(|members| members.len() == 2)
            .map(|_| ())
    })
    .await;
    relay.leave().await;
    host.stop().await;
}

/* ---------------- 一条连接里好几篇（设计 §22.5） ---------------- */

/// 文件夹范围的主持人：哪篇都不直接给，访客要哪篇都先问（DocOpen）
async fn start_folder_host() -> (Host, UnboundedReceiver<Event>) {
    let (events, rx) = unbounded_channel();
    let host = Host::start(
        HostOptions {
            scope: protocol::Scope {
                kind: protocol::ScopeKind::Folder,
                doc: String::new(),
                name: "周报".into(),
            },
            note: String::new(),
            ..host_options("周报")
        },
        events,
    )
    .await
    .expect("主持人起不来");
    (host, rx)
}

/// 文件夹范围里加入并被允许：返回访客拿到的成员号（这时还一篇都没开）
async fn admitted_to_folder(
    host: &Host,
    host_events: &mut UnboundedReceiver<Event>,
    name: &str,
    permission: Permission,
) -> (Guest, UnboundedReceiver<Event>, u16) {
    let (guest, mut events) = join(name, loopback(host, host.invite())).await;
    let request = expect(host_events, "加入请求", |event| match event {
        Event::Control(Control::JoinRequest { request, name: who, .. }) if who == name => Some(*request),
        _ => None,
    })
    .await;
    assert!(host.answer(request, Decision::Allow(permission)));
    let member = expect(&mut events, "进来了", |event| match status_of(event) {
        Some(Status::Connected { member, scope, .. }) => {
            assert_eq!(scope.kind, protocol::ScopeKind::Folder);
            assert_eq!(scope.name, "周报");
            Some(member)
        }
        _ => None,
    })
    .await;
    (guest, events, member)
}

/// 访客要开 doc：主持人那边等到 DocOpen，照 answer 回话
async fn open_doc(
    host: &Host,
    host_events: &mut UnboundedReceiver<Event>,
    guest: &Guest,
    member: u16,
    doc: &str,
    answer: Result<(), String>,
) {
    guest.open_doc(doc);
    let request = expect(host_events, "要开一篇", |event| match event {
        Event::Control(Control::DocOpen { request, member: who, doc: wanted }) if *who == member && wanted == doc => {
            Some(*request)
        }
        _ => None,
    })
    .await;
    assert!(host.answer_doc(request, answer));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_folder_session_opens_docs_on_request_and_keeps_them_apart() {
    let (host, mut host_events) = start_folder_host().await;
    // 树在访客进来之前就给了：进来就收到
    host.set_tree(br#"{"docs":["a","b"]}"#.to_vec());
    let (guest, mut guest_events, member) =
        admitted_to_folder(&host, &mut host_events, "Alex", Permission::Edit).await;
    expect(&mut guest_events, "树", |event| match event {
        Event::Control(Control::Tree { tree }) => Some(assert_eq!(tree, r#"{"docs":["a","b"]}"#)),
        _ => None,
    })
    .await;

    // 开 a：主持人给 → 两边都被叫去同步这一篇
    open_doc(&host, &mut host_events, &guest, member, "a", Ok(())).await;
    expect(&mut guest_events, "访客同步 a", |event| {
        matches!(event, Event::SyncStart { with: 0, doc } if doc == "a").then_some(())
    })
    .await;
    expect(&mut host_events, "主持人同步 a", |event| {
        matches!(event, Event::SyncStart { with, doc } if *with == member && doc == "a").then_some(())
    })
    .await;
    // 主持人这边看得到他开着哪篇
    let docs = host.members().into_iter().find(|info| info.member == member).unwrap().docs;
    assert_eq!(docs, vec!["a".to_string()]);

    // 不在范围里的：说为什么，不再要它
    open_doc(&host, &mut host_events, &guest, member, "secret", Err("不在共享的文件夹里".into())).await;
    let refused = expect(&mut guest_events, "不给", |event| match event {
        Event::Control(Control::DocRefused { doc, reason }) if doc == "secret" => Some(reason.clone()),
        _ => None,
    })
    .await;
    assert_eq!(refused, "不在共享的文件夹里");

    // 更新只给开着那一篇的：a 的到了，没开的 c 的不到
    host.send_update("c", b"c-update".to_vec());
    host.send_update("a", b"a-update".to_vec());
    expect(&mut guest_events, "a 的更新", |event| match event {
        Event::Update { from: 0, doc, bytes } if doc == "a" => Some(assert_eq!(bytes, b"a-update")),
        Event::Update { doc, .. } if doc == "c" => panic!("没开 c 却收到了 c 的更新"),
        _ => None,
    })
    .await;
    guest.send_update("a", b"from-guest".to_vec());
    expect(&mut host_events, "访客在 a 里的更新", |event| {
        matches!(event, Event::Update { from, doc, bytes } if *from == member && doc == "a" && bytes == b"from-guest")
            .then_some(())
    })
    .await;
    // 光标带着是哪篇
    let got = tokio::time::timeout(WAIT, async {
        loop {
            guest.send_cursor("a", b"caret");
            tokio::time::sleep(Duration::from_millis(50)).await;
            while let Ok(event) = host_events.try_recv() {
                if matches!(&event, Event::Cursor { from, doc, bytes } if *from == member && doc == "a" && bytes == b"caret") {
                    return;
                }
            }
        }
    })
    .await;
    assert!(got.is_ok(), "主持人收不到 a 里的光标");

    // 第二位访客只开 b：第一位在 a 里打的字不给他
    let (other, mut other_events, other_member) =
        admitted_to_folder(&host, &mut host_events, "佐藤", Permission::Read).await;
    open_doc(&host, &mut host_events, &other, other_member, "b", Ok(())).await;
    expect(&mut other_events, "佐藤同步 b", |event| {
        matches!(event, Event::SyncStart { doc, .. } if doc == "b").then_some(())
    })
    .await;
    guest.send_update("a", b"only-a".to_vec());
    expect_none(&mut other_events, "别的篇的更新", |event| matches!(event, Event::Update { .. })).await;

    // 新建：能写的交给主持人建，回来文档 id；只读的不行
    let creator = guest.creator();
    let created = tokio::spawn(async move { creator.create("项目", "新的一篇").await });
    let request = expect(&mut host_events, "要新建", |event| match event {
        Event::Control(Control::CreateDoc { request, member: who, folder, title }) if *who == member => {
            assert_eq!((folder.as_str(), title.as_str()), ("项目", "新的一篇"));
            Some(*request)
        }
        _ => None,
    })
    .await;
    assert!(host.answer_create(request, Ok("n-9".into())));
    assert_eq!(created.await.unwrap(), Ok("n-9".to_string()));
    let refused = other.creator().create("", "只读的人建的").await;
    assert!(refused.unwrap_err().contains("只读"));

    // 关掉 a：主持人那边知道
    guest.close_doc("a");
    expect(&mut host_events, "关掉了 a", |event| {
        matches!(event, Event::Control(Control::DocClosed { member: who, doc }) if *who == member && doc == "a")
            .then_some(())
    })
    .await;

    other.leave().await;
    guest.leave().await;
    host.stop().await;
}
