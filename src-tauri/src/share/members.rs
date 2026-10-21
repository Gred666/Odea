/* ============================================================
共享仓库的成员表（docs/协同编辑.md §20.6）。

`{ 共享 id, 版本号, 成员[设备公钥, 名字, 角色], 签名者, 签名 }`，签名是签名者的设备密钥（ed25519）
对前面那些字段的 postcard 编码签的。

- 只认比手里新、而且签名者在手里那份表里是管理员的（第一次加入的设备手里没有表：认邀请人签的、
  里面有自己的那一张）。两位管理员同时改出同一个版本号：签名字节小的赢 —— 每台设备挑的一样
- 角色：管理员（改成员表、邀请）、可编辑、只读
- 改动只收「连接对面是可编辑以上的成员」发来的（net.rs）；移出的人连不进来了，他手里已有的收不回来
============================================================ */

use iroh::{PublicKey, SecretKey, Signature};
use serde::{Deserialize, Serialize};

/// 成员的角色
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Read,
    Edit,
    Admin,
}

impl Role {
    pub fn can_edit(self) -> bool {
        self >= Role::Edit
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Member {
    /// 设备公钥
    pub id: [u8; 32],
    pub name: String,
    pub role: Role,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Roster {
    pub share: [u8; 16],
    pub version: u64,
    pub members: Vec<Member>,
    pub signer: [u8; 32],
    /// 64 字节（serde 不直接支持 64 字节的数组，存成 Vec）
    pub signature: Vec<u8>,
}

/// 签名覆盖的那几样
#[derive(Serialize)]
struct Signed<'a> {
    share: &'a [u8; 16],
    version: u64,
    members: &'a [Member],
    signer: &'a [u8; 32],
}

impl Roster {
    /// 建共享的那台：只有自己，管理员
    pub fn first(share: [u8; 16], key: &SecretKey, name: &str) -> Self {
        let me = Member {
            id: *key.public().as_bytes(),
            name: name.to_string(),
            role: Role::Admin,
        };
        Self::sign(share, 1, vec![me], key)
    }

    pub fn sign(share: [u8; 16], version: u64, members: Vec<Member>, key: &SecretKey) -> Self {
        let signer = *key.public().as_bytes();
        let body = postcard::to_allocvec(&Signed {
            share: &share,
            version,
            members: &members,
            signer: &signer,
        })
        .expect("成员表编码不会失败");
        Self {
            share,
            version,
            members,
            signer,
            signature: key.sign(&body).to_bytes().to_vec(),
        }
    }

    /// 签名对得上签名者
    pub fn verify(&self) -> bool {
        let Ok(signer) = PublicKey::from_bytes(&self.signer) else { return false };
        let Ok(signature) = <[u8; 64]>::try_from(self.signature.as_slice()) else { return false };
        let Ok(body) = postcard::to_allocvec(&Signed {
            share: &self.share,
            version: self.version,
            members: &self.members,
            signer: &self.signer,
        }) else {
            return false;
        };
        signer
            .verify(&body, &Signature::from_bytes(&signature))
            .is_ok()
    }

    pub fn role_of(&self, id: &[u8; 32]) -> Option<Role> {
        self.members.iter().find(|member| &member.id == id).map(|member| member.role)
    }

    pub fn name_of(&self, id: &[u8; 32]) -> Option<&str> {
        self.members
            .iter()
            .find(|member| &member.id == id)
            .map(|member| member.name.as_str())
    }

    /// 别人发来的这张能不能换掉手里这张：同一个共享、签名对、签名者在我这张里是管理员，而且更新
    /// （版本号大；一样大的话签名字节小的赢）
    pub fn accepts(&self, newer: &Roster) -> bool {
        if newer.share != self.share || !newer.verify() {
            return false;
        }
        if self.role_of(&newer.signer) != Some(Role::Admin) {
            return false;
        }
        newer.version > self.version
            || (newer.version == self.version && newer.signature < self.signature)
    }

    /// 管理员改一次：版本号加一、重新签
    pub fn amended(&self, key: &SecretKey, edit: impl FnOnce(&mut Vec<Member>)) -> Roster {
        let mut members = self.members.clone();
        edit(&mut members);
        Self::sign(self.share, self.version + 1, members, key)
    }
}

/// 第一次加入、手里还没有表：认邀请人签的、里面有我的那一张
pub fn first_roster_ok(roster: &Roster, share: &[u8; 16], inviter: &[u8; 32], me: &[u8; 32]) -> bool {
    &roster.share == share
        && &roster.signer == inviter
        && roster.verify()
        && roster.role_of(inviter) == Some(Role::Admin)
        && roster.role_of(me).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_newer_rosters_signed_by_an_admin_are_taken() {
        let admin = SecretKey::generate();
        let editor = SecretKey::generate();
        let share = [7; 16];
        let first = Roster::first(share, &admin, "甲");
        assert!(first.verify());
        let second = first.amended(&admin, |members| {
            members.push(Member {
                id: *editor.public().as_bytes(),
                name: "乙".into(),
                role: Role::Edit,
            })
        });
        assert!(first.accepts(&second));
        assert!(!second.accepts(&first), "旧的不认");
        // 可编辑的人签的不认
        let forged = second.amended(&editor, |members| members[1].role = Role::Admin);
        assert!(!second.accepts(&forged));
        // 改了内容、签名没跟着改：不认
        let mut tampered = second.amended(&admin, |_| {});
        tampered.members[1].role = Role::Admin;
        assert!(!second.accepts(&tampered));
        // 编码来回一趟还是对的
        let decoded: Roster = postcard::from_bytes(&postcard::to_allocvec(&second).unwrap()).unwrap();
        assert_eq!(decoded, second);
        assert!(decoded.verify());
        assert!(first_roster_ok(&second, &share, admin.public().as_bytes(), editor.public().as_bytes()));
        assert!(!first_roster_ok(&first, &share, admin.public().as_bytes(), editor.public().as_bytes()));
    }

    #[test]
    fn two_admins_editing_at_once_settle_on_the_same_roster() {
        let a = SecretKey::generate();
        let b = SecretKey::generate();
        let base = Roster::first([1; 16], &a, "甲").amended(&a, |members| {
            members.push(Member {
                id: *b.public().as_bytes(),
                name: "乙".into(),
                role: Role::Admin,
            })
        });
        let from_a = base.amended(&a, |members| members[1].name = "乙乙".into());
        let from_b = base.amended(&b, |members| members[0].name = "甲甲".into());
        // 同一个版本号：两边挑出来的是同一张
        let pick = |held: &Roster, other: &Roster| if held.accepts(other) { other.clone() } else { held.clone() };
        assert_eq!(pick(&from_a, &from_b), pick(&from_b, &from_a));
    }
}
