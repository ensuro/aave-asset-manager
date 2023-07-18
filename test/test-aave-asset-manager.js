const { expect } = require("chai");
const {
  deployPool,
  deployPremiumsAccount,
  addRiskModule,
  amountFunction,
  grantComponentRole,
  grantRole,
  getTransactionEvent,
  addEToken,
} = require("@ensuro/core/js/test-utils");
const helpers = require("@nomicfoundation/hardhat-network-helpers");
const hre = require("hardhat");

describe("Test AAVE asset manager - running at https://polygonscan.com/block/33313517", function () {
  let currency;
  let pool;
  let owner, lp, lp2, guardian, admin;
  const _A = amountFunction(6);
  let jrEtk, srEtk;
  let accessManager;
  const CENTS = _A(0.001);

  const ADDRESSES = {
    usdc: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    aave: "0x8dFf5E27EA6b7AC08EbFdf9eB090F32ee9a30fcf",
    aaveV3: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    usrUSDC: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045", // Random account with lot of USDC
    amUSDC: "0x1a13F4Ca1d028320A707D99520AbFefca3998b7F",
    amUSDCv3: "0x625E7708f30cA75bfd92586e17077590C60eb4cD",

    wmatic: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    weth: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    ensuroTreasury: "0x913B9dff6D780cF4cda0b0321654D7261d5593d0", // Random address
    etk: "0xCFfDcC8e99Aa22961704b9C7b67Ed08A66EA45Da",
    variableDebtmUSDC: "0x248960A9d75EdFa3de94F7193eae3161Eb349a12",
    oracle: "0x0229f777b0fab107f9591a41d5f02e4e98db6f2d", // AAVE PriceOracle
    sushi: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506", // Sushiswap router
    assetMgr: "0x09d9Dd252659a497F3525F257e204E7192beF132",
    usrWMATIC: "0x55FF76BFFC3Cdd9D5FdbBC2ece4528ECcE45047e", // Random account with log of WMATIC
  };

  beforeEach(async () => {
    if (process.env.ALCHEMY_URL === undefined) throw new Error("Define envvar ALCHEMY_URL for this test");
    await hre.network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: process.env.ALCHEMY_URL,
            blockNumber: 33313517,
          },
        },
      ],
    });
    [owner, lp2, guardian, admin] = await hre.ethers.getSigners();
    await helpers.impersonateAccount(ADDRESSES.usrUSDC);
    await helpers.setBalance(ADDRESSES.usrUSDC, 100n ** 18n);
    lp = await hre.ethers.getSigner(ADDRESSES.usrUSDC);

    pool = await deployPool(hre, {
      currency: ADDRESSES.usdc,
      grantRoles: [],
      treasuryAddress: "0x12345678901234567890123456789061c9177f41",
    });
    pool._A = _A;

    currency = await hre.ethers.getContractAt("IERC20Metadata", ADDRESSES.usdc);

    srEtk = await addEToken(pool, {});
    jrEtk = await addEToken(pool, {});

    await deployPremiumsAccount(hre, pool, {
      jrEtkAddr: jrEtk.address,
      srEtkAddr: srEtk.address,
    });
    accessManager = await hre.ethers.getContractAt("AccessManager", await pool.access());

    await grantRole(hre, accessManager, "GUARDIAN_ROLE", guardian.address);
    await grantRole(hre, accessManager, "LEVEL1_ROLE", admin.address);

    // Grant roles to set parameters
    await grantComponentRole(hre, accessManager, jrEtk, "LEVEL2_ROLE", admin.address);
    await grantComponentRole(hre, accessManager, srEtk, "LEVEL2_ROLE", admin.address);

    await currency.connect(lp).approve(pool.address, _A(100000));
  });

  async function setupAAVEv2() {
    const amContract = await hre.ethers.getContractFactory("AAVEv2AssetManager");
    const aToken = await hre.ethers.getContractAt("IERC20Metadata", ADDRESSES.amUSDC);
    const aaveAddress = ADDRESSES.aave;
    const am = await amContract.deploy(ADDRESSES.usdc, aaveAddress);
    const deployFunction = async function (asset, aaveAddress) {
      return await amContract.deploy(asset, aaveAddress);
    };
    return { amContract, aToken, aaveAddress, am, deployFunction };
  }

  async function setupAAVEv3() {
    const amContract = await hre.ethers.getContractFactory("AAVEv3AssetManager");
    const aToken = await hre.ethers.getContractAt("IERC20Metadata", ADDRESSES.amUSDCv3);
    const aaveAddress = ADDRESSES.aaveV3;
    const am = await amContract.deploy(ADDRESSES.usdc, aaveAddress);
    const deployFunction = async function (asset, aaveAddress) {
      return await amContract.deploy(asset, aaveAddress);
    };
    return { amContract, aToken, aaveAddress, am, deployFunction };
  }

  async function setupAAVEv3PlusVault() {
    const amContract = await hre.ethers.getContractFactory("AAVEv3PlusVaultAssetManager");
    const TestVault = await hre.ethers.getContractFactory("TestVault");
    const aToken = await hre.ethers.getContractAt("IERC20Metadata", ADDRESSES.amUSDCv3);
    const aaveAddress = ADDRESSES.aaveV3;
    const vault = await TestVault.deploy("Test Vault", "TEST", ADDRESSES.usdc);
    const am = await amContract.deploy(ADDRESSES.usdc, aaveAddress, vault.address);
    const deployFunction = async function (asset, aaveAddress) {
      return await amContract.deploy(asset, aaveAddress, vault.address);
    };
    return { amContract, aToken, aaveAddress, am, deployFunction, vault };
  }

  const variants = [
    { name: "AAVEv2", setup: setupAAVEv2 },
    { name: "AAVEv3", setup: setupAAVEv3 },
    { name: "AAVEv3PlusVault", setup: setupAAVEv3PlusVault },
  ];

  variants.map((variant) => {
    const _tn = (testName) => `${testName} - ${variant.name}`;

    it(_tn("Creates an asset manager and does several flow"), async () => {
      const { amContract, aToken, am } = await variant.setup();
      await pool.connect(lp).deposit(jrEtk.address, _A(10000));
      expect(await am.getInvestmentValue()).to.be.equal(_A(0)); // Implementation balance is 0

      expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(10000));

      await jrEtk.connect(admin).setAssetManager(am.address, false);

      await jrEtk
        .connect(admin)
        .forwardToAssetManager(
          amContract.interface.encodeFunctionData("setLiquidityThresholds", [_A(1000), _A(2000), _A(3000)])
        );

      let tx = await jrEtk.checkpoint();
      let receipt = await tx.wait();
      expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(2000));
      expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(_A(8000), CENTS);
      let evt = getTransactionEvent(am.interface, receipt, "MoneyInvested");
      expect(evt.args.amount).to.be.equal(_A(8000));

      // After some time, earnings generated and distributed
      await helpers.time.increase(3600 * 24 * 365);
      const newBalance = await aToken.balanceOf(jrEtk.address);
      expect(newBalance).to.be.gt(_A(8000)); // Yields produced by AAVE's interest rate
      tx = await jrEtk.recordEarnings();
      receipt = await tx.wait();
      evt = getTransactionEvent(am.interface, receipt, "EarningsRecorded");
      expect(evt.args.earnings).to.be.closeTo(newBalance - _A(8000), CENTS);
      expect(await jrEtk.balanceOf(lp.address)).to.closeTo(newBalance.add(_A(2000)), CENTS);

      // Withdrawal more than ETK liquidity requires deinvestment
      tx = await pool.connect(lp).withdraw(jrEtk.address, _A(3000));
      receipt = await tx.wait();
      evt = getTransactionEvent(am.interface, receipt, "MoneyDeinvested");
      expect(evt.args.amount).to.be.equal(_A(3000));
      expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(2000)); // jrEtk stays at middle
      expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(newBalance - _A(3000), CENTS);

      // Withdrawal less than ETK liquidity doesn't
      tx = await pool.connect(lp).withdraw(jrEtk.address, _A(1500));
      receipt = await tx.wait();
      evt = getTransactionEvent(am.interface, receipt, "MoneyDeinvested");
      expect(evt).to.be.equal(null);
      expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(500));
      expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(newBalance - _A(3000), CENTS);

      // Rebalance refills ETK liquidity
      tx = await jrEtk.rebalance();
      receipt = await tx.wait();
      evt = getTransactionEvent(am.interface, receipt, "MoneyDeinvested");
      expect(evt.args.amount).to.be.equal(_A(1500));
      expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(2000)); // jrEtk back at middle
      expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(newBalance - _A(4500), CENTS);

      // Setting AM to zero deinvests all
      const preBalance = await aToken.balanceOf(jrEtk.address);
      await helpers.time.increase(3600 * 24 * 90);
      const postBalance = await aToken.balanceOf(jrEtk.address);
      expect(postBalance).to.be.gt(preBalance); // some returns
      tx = await jrEtk.connect(admin).setAssetManager(hre.ethers.constants.AddressZero, false);
      receipt = await tx.wait();
      expect(await aToken.balanceOf(jrEtk.address)).to.be.equal(0);
      expect(await currency.balanceOf(jrEtk.address)).to.be.closeTo(_A(2000).add(postBalance), CENTS);
      evt = getTransactionEvent(am.interface, receipt, "MoneyDeinvested");
      expect(evt.args.amount).to.be.closeTo(postBalance, CENTS);
      evt = getTransactionEvent(am.interface, receipt, "EarningsRecorded");
      expect(evt.args.earnings).to.be.closeTo(postBalance.sub(preBalance), CENTS);
    });

    it(_tn("Tests an asset manager shared by two reserves"), async () => {
      const { amContract, aToken, am } = await variant.setup();
      await pool.connect(lp).deposit(jrEtk.address, _A(10000));
      await currency.connect(lp).transfer(lp2.address, _A(5000)); // give some money to my friend lp2
      await currency.connect(lp2).approve(pool.address, hre.ethers.constants.MaxUint256);
      await pool.connect(lp2).deposit(srEtk.address, _A(5000));

      expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(10000));
      expect(await currency.balanceOf(srEtk.address)).to.be.equal(_A(5000));

      await jrEtk.connect(admin).setAssetManager(am.address, false);
      await srEtk.connect(guardian).setAssetManager(am.address, false);

      await jrEtk
        .connect(admin)
        .forwardToAssetManager(
          amContract.interface.encodeFunctionData("setLiquidityThresholds", [_A(1000), _A(2000), _A(3000)])
        );

      await srEtk
        .connect(admin)
        .forwardToAssetManager(
          amContract.interface.encodeFunctionData("setLiquidityThresholds", [_A(500), _A(1000), _A(1500)])
        );

      await jrEtk.checkpoint();
      await srEtk.checkpoint();
      expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(10000 - 8000));
      expect(await currency.balanceOf(srEtk.address)).to.be.equal(_A(5000 - 4000));
      expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(_A(8000), CENTS);
      expect(await aToken.balanceOf(srEtk.address)).to.be.closeTo(_A(4000), CENTS);

      await jrEtk.connect(guardian).setAssetManager(ethers.constants.AddressZero, false);
      expect(await aToken.balanceOf(jrEtk.address)).to.be.equal(0);
      expect(await currency.balanceOf(jrEtk.address)).to.be.closeTo(_A(10000), CENTS);

      await srEtk.connect(admin).setAssetManager(ethers.constants.AddressZero, false);
      expect(await aToken.balanceOf(srEtk.address)).to.be.equal(0);
      expect(await currency.balanceOf(srEtk.address)).to.be.closeTo(_A(5000), CENTS);
    });

    it(_tn("Can deinvestAll when no funds in AAVE"), async function () {
      const { am } = await variant.setup();
      await jrEtk.connect(admin).setAssetManager(am.address, false);
      await jrEtk.connect(admin).setAssetManager(ethers.constants.AddressZero, false);
    });

    it(_tn("Can change the AM"), async function () {
      const { am, amContract, aaveAddress, aToken, deployFunction } = await variant.setup();
      await jrEtk.connect(admin).setAssetManager(am.address, false);
      await currency.connect(lp).approve(pool.address, hre.ethers.constants.MaxUint256);
      await pool.connect(lp).deposit(jrEtk.address, _A(2000));
      await jrEtk
        .connect(admin)
        .forwardToAssetManager(
          amContract.interface.encodeFunctionData("setLiquidityThresholds", [_A(100), _A(160), _A(200)])
        );
      await jrEtk.checkpoint();
      expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(160));
      expect(await aToken.balanceOf(jrEtk.address)).to.be.equal(_A(2000 - 160));
      expect(await jrEtk.totalSupply()).to.be.equal(_A(2000));

      const am2 = await await deployFunction(ADDRESSES.usdc, aaveAddress);
      await jrEtk.connect(admin).setAssetManager(am2.address, false);
      // am deinvested
      expect(await currency.balanceOf(jrEtk.address)).to.be.closeTo(_A(2000), _A("0.001"));
      expect(await aToken.balanceOf(jrEtk.address)).to.be.equal(_A(0));
      expect(await jrEtk.totalSupply()).to.be.closeTo(_A(2000), _A("0.001"));

      // Reset the liquidity thresholds, becase the storage is cleaned on connect
      await jrEtk
        .connect(admin)
        .forwardToAssetManager(
          amContract.interface.encodeFunctionData("setLiquidityThresholds", [_A(100), _A(160), _A(200)])
        );

      await jrEtk.checkpoint();
      expect(await jrEtk.totalSupply()).to.be.closeTo(_A(2000), _A("0.001"));
      // liquidity Thesholds reused because re-using the same storage
      expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(160));
      expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(_A(2000 - 160), _A("0.001"));
    });
  });

  it("Checks AAVEv3PlusVaultAssetManager requires a vault and has to be the same asset", async function () {
    const AAVEv3PlusVaultAssetManager = await hre.ethers.getContractFactory("AAVEv3PlusVaultAssetManager");
    const TestVault = await hre.ethers.getContractFactory("TestVault");
    await expect(
      AAVEv3PlusVaultAssetManager.deploy(ADDRESSES.usdc, ADDRESSES.aaveV3, ethers.constants.AddressZero)
    ).to.be.revertedWith("AAVEv3PlusVaultAssetManager: vault cannot be zero address");
    const wrongVault = await TestVault.deploy("AToken USDC", "amUSDC", ADDRESSES.amUSDCv3);
    await expect(
      AAVEv3PlusVaultAssetManager.deploy(ADDRESSES.usdc, ADDRESSES.aaveV3, wrongVault.address)
    ).to.be.revertedWith("AAVEv3PlusVaultAssetManager: vault must have the same asset");
  });

  it("Tests AAVEv3PlusVaultAssetManager with vault investment", async () => {
    const { amContract, aToken, am, vault } = await setupAAVEv3PlusVault();
    await pool.connect(lp).deposit(jrEtk.address, _A(10000));
    expect(await am.getInvestmentValue()).to.be.equal(_A(0)); // Implementation balance is 0

    expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(10000));

    // LP deposits some money in the vault
    await currency.connect(lp).approve(vault.address, ethers.constants.MaxUint256);
    await vault.connect(lp).deposit(_A(1000), lp.address);

    await jrEtk.connect(admin).setAssetManager(am.address, false);

    await jrEtk
      .connect(admin)
      .forwardToAssetManager(
        amContract.interface.encodeFunctionData("setLiquidityThresholds", [_A(1000), _A(2000), _A(3000)])
      );

    let tx = await jrEtk.checkpoint();
    let receipt = await tx.wait();
    expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(2000));
    expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(_A(8000), CENTS);
    let evt = getTransactionEvent(am.interface, receipt, "MoneyInvested");
    expect(evt.args.amount).to.be.equal(_A(8000));

    expect(await vault.totalAssets()).to.be.equal(_A(1000));
    expect(await vault.balanceOf(jrEtk.address)).to.be.equal(_A(0));

    // Not enough funds in AAVE
    await expect(
      jrEtk.connect(admin).forwardToAssetManager(amContract.interface.encodeFunctionData("aaveToVault", [_A(9000)]))
    ).to.be.reverted;

    await jrEtk
      .connect(admin)
      .forwardToAssetManager(amContract.interface.encodeFunctionData("aaveToVault", [_A(5000)]));

    expect(await vault.totalAssets()).to.be.equal(_A(6000));
    expect(await vault.balanceOf(jrEtk.address)).to.be.equal(_A(5000));
    expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(_A(3000), CENTS);

    expect(await jrEtk.checkpoint())
      .not.to.emit(am.interface, "MoneyInvested")
      .not.to.emit(am.interface, "MoneyDeinvested");

    // Transfer all from AAVE
    await jrEtk
      .connect(admin)
      .forwardToAssetManager(amContract.interface.encodeFunctionData("aaveToVault", [ethers.constants.MaxUint256]));

    expect(await vault.totalAssets()).to.be.closeTo(_A(9000), CENTS);
    expect(await vault.balanceOf(jrEtk.address)).to.be.closeTo(_A(8000), CENTS);
    expect(await aToken.balanceOf(jrEtk.address)).to.be.equal(_A(0));

    expect(await jrEtk.checkpoint())
      .not.to.emit(am.interface, "MoneyInvested")
      .not.to.emit(am.interface, "MoneyDeinvested");

    // Remove some liquidity from the vault (useful later)
    await vault.lend(lp.address, _A(3000));
    expect(await vault.totalAssets()).to.be.closeTo(_A(9000), CENTS); // unchanged
    expect(await vault.maxWithdraw(jrEtk.address)).to.be.closeTo(_A(6000), CENTS); // some not withdrawable

    // Not enough liquidity in the vault
    await expect(
      jrEtk.connect(admin).forwardToAssetManager(amContract.interface.encodeFunctionData("vaultToAave", [_A(7000)]))
    ).to.be.reverted;

    // Losses of the vault impact the reserve - A loss of 1000 is distributed between vault owners
    await vault.debtDefault(_A(1000));

    tx = await jrEtk.recordEarnings();
    receipt = await tx.wait();
    evt = getTransactionEvent(am.interface, receipt, "EarningsRecorded");
    expect(evt.args.earnings).to.be.closeTo(_A((-1000 * 8000) / 9000), CENTS);
    expect(await jrEtk.balanceOf(lp.address)).to.closeTo(_A(10000 - (1000 * 8000) / 9000), CENTS);

    // Earnings too (here 100 as interest)
    await vault.repay(lp.address, _A(500), _A(100));

    tx = await jrEtk.recordEarnings();
    receipt = await tx.wait();
    evt = getTransactionEvent(am.interface, receipt, "EarningsRecorded");
    expect(evt.args.earnings).to.be.closeTo(_A((100 * 8000) / 9000), CENTS);
    expect(await jrEtk.balanceOf(lp.address)).to.closeTo(_A(10000 - (900 * 8000) / 9000), CENTS);

    // balance in shares unchanged - in assets changed because of the losses
    const shares = await vault.balanceOf(jrEtk.address);
    expect(shares).to.be.closeTo(_A(8000), CENTS);
    expect(await vault.previewRedeem(shares)).to.be.closeTo(_A(8000 - (900 * 8000) / 9000), CENTS);

    await expect(
      jrEtk.connect(admin).forwardToAssetManager(amContract.interface.encodeFunctionData("vaultToAave", [_A(5000)]))
    ).not.to.be.reverted;

    // After some time, earnings generated and distributed
    await helpers.time.increase(3600 * 24 * 365);
    const newBalance = await aToken.balanceOf(jrEtk.address);
    expect(newBalance).to.be.gt(_A(5000)); // Yields produced by AAVE's interest rate
    tx = await jrEtk.recordEarnings();
    receipt = await tx.wait();
    evt = getTransactionEvent(am.interface, receipt, "EarningsRecorded");
    expect(evt.args.earnings).to.be.closeTo(newBalance - _A(5000), CENTS);
    expect(await jrEtk.balanceOf(lp.address)).to.closeTo(
      newBalance.add(_A(2000)).add(_A(3000 - (900 * 8000) / 9000)),
      CENTS
    );

    // Sending MaxUint256 withdraws as much as possible
    await expect(
      jrEtk
        .connect(admin)
        .forwardToAssetManager(amContract.interface.encodeFunctionData("vaultToAave", [ethers.constants.MaxUint256]))
    ).not.to.be.reverted;

    expect(await vault.maxRedeem(jrEtk.address)).to.be.closeTo(_A(0), _A(0.0001));

    // Withdrawal more than ETK liquidity requires deinvestment
    tx = await pool.connect(lp).withdraw(jrEtk.address, _A(3000));
    receipt = await tx.wait();
    evt = getTransactionEvent(am.interface, receipt, "MoneyDeinvested");
    expect(evt.args.amount).to.be.equal(_A(3000));
    expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(2000)); // jrEtk stays at middle
    expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(newBalance - _A(1400), CENTS);

    // Withdrawal less than ETK liquidity doesn't
    tx = await pool.connect(lp).withdraw(jrEtk.address, _A(1500));
    receipt = await tx.wait();
    evt = getTransactionEvent(am.interface, receipt, "MoneyDeinvested");
    expect(evt).to.be.equal(null);
    expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(500));
    expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(newBalance - _A(1400), CENTS);

    // Send from money from AAVE to the vault
    await jrEtk
      .connect(admin)
      .forwardToAssetManager(
        amContract.interface.encodeFunctionData("aaveToVault", [(await aToken.balanceOf(jrEtk.address)).sub(_A(400))])
      );

    let assetsBefore = await vault.totalAssets();
    expect(await vault.maxRedeem(jrEtk.address)).to.be.closeTo(_A(3586.812), CENTS);
    expect(await aToken.balanceOf(jrEtk.address)).to.be.closeTo(_A(400), CENTS);

    // Rebalance refills ETK liquidity
    expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(500));
    tx = await jrEtk.rebalance();
    receipt = await tx.wait();
    evt = getTransactionEvent(am.interface, receipt, "MoneyDeinvested");
    expect(evt.args.amount).to.be.equal(_A(1500));
    expect(await currency.balanceOf(jrEtk.address)).to.be.equal(_A(2000)); // jrEtk back at middle
    expect(await aToken.balanceOf(jrEtk.address)).to.be.equal(0);
    expect(await vault.totalAssets()).to.be.closeTo(assetsBefore.sub(_A(1100)), CENTS);
    const assetsInVaultBefore = await vault.previewRedeem(await vault.balanceOf(jrEtk.address));

    // Setting AM to zero deinvests all
    tx = await jrEtk.connect(admin).setAssetManager(hre.ethers.constants.AddressZero, false);
    receipt = await tx.wait();
    expect(await aToken.balanceOf(jrEtk.address)).to.be.equal(0);

    expect(await vault.previewRedeem(await vault.balanceOf(jrEtk.address))).to.be.equal(_A(600));

    expect(await currency.balanceOf(jrEtk.address)).to.be.closeTo(
      _A(2000).add(assetsInVaultBefore.sub(_A(600))),
      CENTS
    );
    evt = getTransactionEvent(am.interface, receipt, "MoneyDeinvested");
    expect(evt.args.amount).to.be.closeTo(assetsInVaultBefore.sub(_A(600)), CENTS);
    evt = getTransactionEvent(am.interface, receipt, "EarningsRecorded");
    expect(evt.args.earnings).to.be.closeTo(_A(-600), CENTS);
  });
});
